#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
hdc_probe.py —— 用 libusb 直接跟 HarmonyOS 设备的 hdc 守护进程对话，把双向字节全部录下来。

用途：不需要 Wireshark / USBPcap / 管理员权限，就能拿到 HDC 的
      握手（SessionHandShake）与 RSA 鉴权交换的真实字节。

前提（已由上一轮实测确认可行）：
  - 设备是 HDC 接口 interface #0，class 0xFF/0x50/0x01
  - bulk IN = 0x81，bulk OUT = 0x01
  - `hdc kill` 之后，普通用户权限即可 claim_interface(0) 成功

安全：
  - 只做 claim / bulk 读写 / release，不碰固件、不改设备状态
  - 全程不写设备文件
  - 若中途异常，脚本会 release + close；再 `hdc list targets` 即可恢复
  - 万一设备进入异常状态：拔插一次数据线即可（脚本不会造成持久影响）

用法：
  python hdc_probe.py                # 完整流程：静默读 → 发会话握手 → 读
  python hdc_probe.py --read-only    # 只读，什么都不发（最保守）
  python hdc_probe.py --vid 12D1 --pid 1101 --serial <DEVICE_SERIAL>
"""

from __future__ import annotations

import argparse
import ctypes
import json
import os
import sys
import time
from ctypes import POINTER, byref, c_int, c_uint, c_uint8, c_uint16, c_void_p

# ---------------------------------------------------------------- 常量（来自实测）

USB_HEAD = 11          # [55 42][01][sessionId:4][len:4 BE]
HW_MAGIC = b"HW"
VCODE = 0x09
BANNER = b"OHOS HDC"
EP_IN = 0x81
EP_OUT = 0x01
INTERFACE = 0

LIBUSB_TIMEOUT = -7
LIBUSB_ERROR_NAMES = {
    0: "OK",
    -1: "IO",
    -2: "INVALID_PARAM",
    -3: "ACCESS",
    -4: "NO_DEVICE",
    -5: "NOT_FOUND",
    -6: "BUSY",
    -7: "TIMEOUT",
    -8: "OVERFLOW",
    -9: "PIPE",
    -10: "INTERRUPTED",
    -11: "NO_MEM",
    -12: "NOT_SUPPORTED",
}


def log(msg: str) -> None:
    print(msg, flush=True)


def hexdump(data: bytes, prefix: str = "  ") -> str:
    lines = []
    for i in range(0, len(data), 16):
        chunk = data[i : i + 16]
        hx = " ".join(f"{b:02X}" for b in chunk)
        asc = "".join(chr(b) if 32 <= b < 127 else "." for b in chunk)
        lines.append(f"{prefix}{i:04X}  {hx:<48}  {asc}")
    return "\n".join(lines)


# ---------------------------------------------------------------- protobuf


def varint(n: int) -> bytes:
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def f_varint(num: int, value: int) -> bytes:
    return varint(num * 8) + varint(value)


def f_bytes(num: int, value: bytes) -> bytes:
    return varint(num * 8 + 2) + varint(len(value)) + value


# ---------------------------------------------------------------- 帧构造


def build_frame(channel_id: int, command_flag: int, payload: bytes, check_sum: int = 0) -> bytes:
    """构造一个 HDC 帧：[11B PayloadHead][会话头 protobuf][负载]"""
    head = (
        f_varint(1, channel_id)
        + f_varint(2, command_flag)
        + f_varint(3, check_sum)
        + f_varint(4, VCODE)
    )
    out = bytearray()
    out += HW_MAGIC
    out += b"\x00\x00"
    out.append(0x01)
    out += len(head).to_bytes(2, "big")
    out += len(payload).to_bytes(4, "big")
    out += head
    out += payload
    return bytes(out)


def build_usb_packet(session_id: int, frame: bytes) -> bytes:
    """在帧前面加 11 字节 UB 包头"""
    head = bytearray()
    head += b"UB"
    head.append(0x01)
    head += (session_id & 0xFFFFFFFF).to_bytes(4, "big")
    head += len(frame).to_bytes(4, "big")
    return bytes(head) + frame


def build_session_handshake(session_id: int, connect_key: bytes, version: bytes, auth_type: int = 4) -> bytes:
    """
    会话握手负载（protobuf）。字段号来自真机抓到的样本：
      1=banner  2=sessionId  3=? 4=? 5=? 6=version
    字段名以 hdc 日志为准（banner/sessionId/authType/connectKey/version），
    但编号与名字的对应关系**尚未证实**，故这里按实测样本的形状构造，
    并把 authType 与 connectKey 同时塞进去，让设备自己挑：
      - 如果设备回错误，我们仍能拿到它的错误字节，同样有价值。
    """
    payload = (
        f_bytes(1, BANNER)
        + f_varint(2, session_id)
        + f_varint(3, auth_type)
        + f_bytes(4, connect_key)
        + f_bytes(5, b"")
        + f_bytes(6, version)
    )
    return payload


# ---------------------------------------------------------------- libusb


class Libusb:
    def __init__(self, dll_path: str):
        self.dll = ctypes.CDLL(dll_path)
        d = self.dll
        d.libusb_init.argtypes = [POINTER(c_void_p)]
        d.libusb_init.restype = c_int
        d.libusb_exit.argtypes = [c_void_p]
        d.libusb_open_device_with_vid_pid.argtypes = [c_void_p, c_uint16, c_uint16]
        d.libusb_open_device_with_vid_pid.restype = c_void_p
        d.libusb_claim_interface.argtypes = [c_void_p, c_int]
        d.libusb_claim_interface.restype = c_int
        d.libusb_release_interface.argtypes = [c_void_p, c_int]
        d.libusb_release_interface.restype = c_int
        d.libusb_bulk_transfer.argtypes = [
            c_void_p, c_uint8, POINTER(c_uint8), c_int, POINTER(c_int), c_uint,
        ]
        d.libusb_bulk_transfer.restype = c_int
        d.libusb_close.argtypes = [c_void_p]
        d.libusb_close.restype = None
        self.ctx = c_void_p()
        rc = d.libusb_init(byref(self.ctx))
        if rc != 0:
            raise RuntimeError(f"libusb_init 失败 rc={rc}")

    def open(self, vid: int, pid: int):
        dev = self.dll.libusb_open_device_with_vid_pid(self.ctx, vid, pid)
        if not dev:
            raise RuntimeError(
                f"打不开 {vid:04X}:{pid:04X}。常见原因：hdc server 还占着设备（先 hdc kill），"
                f"或 VID/PID 不对。"
            )
        return dev

    def claim(self, dev, iface: int) -> int:
        rc = self.dll.libusb_claim_interface(dev, iface)
        return rc

    def release(self, dev, iface: int) -> None:
        self.dll.libusb_release_interface(dev, iface)

    def read(self, dev, ep: int, size: int = 4096, timeout_ms: int = 1500):
        buf = (c_uint8 * size)()
        actual = c_int(0)
        rc = self.dll.libusb_bulk_transfer(dev, ep, buf, size, byref(actual), timeout_ms)
        if rc == 0 and actual.value > 0:
            return bytes(buf[: actual.value])
        return None if rc == LIBUSB_TIMEOUT else rc

    def write(self, dev, ep: int, data: bytes, timeout_ms: int = 2000) -> int:
        arr = (c_uint8 * len(data)).from_buffer_copy(data)
        actual = c_int(0)
        rc = self.dll.libusb_bulk_transfer(dev, ep, arr, len(data), byref(actual), timeout_ms)
        return rc

    def close(self, dev) -> None:
        self.dll.libusb_close(dev)


# ---------------------------------------------------------------- 主流程


def find_libusb(explicit: str | None) -> str:
    if explicit:
        return explicit
    candidates = [
        r"C:\Program Files\Huawei\DevEco Studio\sdk\default\openharmony\toolchains\libusb_shared.dll",
        r"C:\Program Files\Huawei\DevEco Studio\sdk\default\openharmony\toolchains\libusb_shared.so",
        "libusb_shared.dll",
        "libusb-1.0.dll",
    ]
    for c in candidates:
        if os.path.exists(c):
            return c
    raise SystemExit(
        "找不到 libusb。请用 --libusb 指定路径，例如：\n"
        r'  --libusb "C:\Program Files\Huawei\DevEco Studio\sdk\default\openharmony\toolchains\libusb_shared.dll"'
    )


def drain(usb: Libusb, dev, seconds: float, tag: str, records: list, quiet_timeout: int = 1200) -> None:
    """在 seconds 时间内持续读取并记录。每次读不到就继续等，直到超时。"""
    deadline = time.time() + seconds
    while time.time() < deadline:
        got = usb.read(dev, EP_IN, timeout_ms=quiet_timeout)
        if got is None:
            continue
        if isinstance(got, int):
            log(f"[{tag}] 读取失败 rc={got} {LIBUSB_ERROR_NAMES.get(got, '')}")
            return
        records.append({"phase": tag, "dir": "IN", "len": len(got), "hex": got.hex()})
        log(f"[{tag}] IN {len(got)} 字节")
        log(hexdump(got))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--vid", default="12D1")
    ap.add_argument("--pid", default="1101")
    ap.add_argument("--serial", default="", help="设备序列号，写进 connectKey")
    ap.add_argument("--libusb", default=None)
    ap.add_argument("--version", default="Ver: 3.2.0f", help="声称的客户端版本")
    ap.add_argument("--read-only", action="store_true", help="只读，不发送任何数据")
    ap.add_argument("--passive-seconds", type=float, default=4.0)
    ap.add_argument("--active-seconds", type=float, default=8.0)
    ap.add_argument("--out", default="hdc_probe_log.jsonl")
    args = ap.parse_args()

    vid = int(args.vid, 16)
    pid = int(args.pid, 16)
    dll_path = find_libusb(args.libusb)
    log(f"libusb: {dll_path}")

    records: list[dict] = []
    usb = Libusb(dll_path)
    dev = None
    claimed = False
    try:
        dev = usb.open(vid, pid)
        log(f"已打开设备 {vid:04X}:{pid:04X}")
        rc = usb.claim(dev, INTERFACE)
        if rc != 0:
            log(f"claim_interface({INTERFACE}) 失败 rc={rc} {LIBUSB_ERROR_NAMES.get(rc, '')}")
            log("提示：先执行 `hdc kill`，等 1 秒再跑本脚本。")
            return 2
        claimed = True
        log(f"已 claim interface {INTERFACE}")

        log("\n=== 阶段 A：静默监听（看设备自己会发什么）===")
        drain(usb, dev, args.passive_seconds, "A-passive", records)

        if args.read_only:
            log("\n--read-only，跳过发送阶段")
        else:
            log("\n=== 阶段 B：主动发送会话握手，然后读回应 ===")
            session_id = int.from_bytes(os.urandom(4), "big")
            version = args.version.encode()
            key = args.serial.encode()
            payload = build_session_handshake(session_id, key, version, auth_type=4)
            # commandFlag=1 = 会话握手（实测样本里 08 00 10 01 18 00 20 09 的 flag 为 1）
            frame = build_frame(0, 1, payload)
            packet = build_usb_packet(session_id, frame)
            log(f"即将发送 {len(packet)} 字节：UB包头(11) + 帧({len(frame)})")
            log(hexdump(packet))
            rc = usb.write(dev, EP_OUT, packet)
            if rc != 0:
                log(f"[B] 写入失败 rc={rc} {LIBUSB_ERROR_NAMES.get(rc, '')}")
            else:
                records.append({"phase": "B-send", "dir": "OUT", "len": len(packet), "hex": packet.hex()})
                log(f"[B] 已写出 {len(packet)} 字节")
            drain(usb, dev, args.active_seconds, "B-active", records)

        log("\n=== 汇总 ===")
        log(f"共记录 {len(records)} 个包")
    finally:
        if dev is not None:
            if claimed:
                usb.release(dev, INTERFACE)
                log("已 release interface")
            usb.close(dev)
            log("已关闭设备句柄")
        usb.dll.libusb_exit(usb.ctx)

    with open(args.out, "w", encoding="utf-8") as fh:
        for r in records:
            fh.write(json.dumps(r, ensure_ascii=False) + "\n")
    log(f"\n日志已写入 {os.path.abspath(args.out)}")
    log("请把这个 jsonl 文件回传。若设备表现异常，拔插一次数据线即可。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
