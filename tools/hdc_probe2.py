#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
hdc_probe2.py —— 修正字段顺序后的主动握手探测（第二轮）

与 v1 的区别（v1 失败的真因已定位）：
  v1 把 SessionHandShake 的 f2/f3 写反了。源码 session.h 明确：
      struct SessionHandShake { string banner; uint8_t authType; uint32_t sessionId;
                                string connectKey; string buf; string version; }
  即 f2=authType、f3=sessionId。v1 把随机 sessionId 塞进 f2，设备按 authType 解析
  后判为非法值 → 静默丢弃 → 表现为"写成功但零回应"。

本轮做了：
  1. 字段顺序按源码修正
  2. USBHead.option 显式设为 USB_OPTION_HEADER(1)
  3. 先被动读，**学习设备当前的 sessionId**，用于出站 UB 包头
  4. 一次跑多个变体，逐个 log，便于一次拿全
  5. 额外测试"跳过握手直接发 shell"（设备本就信任本机时可能直接可用）

用法：
  python hdc_probe2.py                 # 跑全部变体
  python hdc_probe2.py --variant 1 4   # 只跑指定变体
  python hdc_probe2.py --two-transfer  # 头部与帧分两次 bulk 发送

安全：只 claim/bulk 读写/release；不写设备文件；异常拔插一次即可恢复。
"""

from __future__ import annotations

import argparse
import ctypes
import json
import os
import sys
import time
from ctypes import POINTER, byref, c_int, c_uint, c_uint8, c_uint16, c_void_p

# ---------------- 协议常量（全部来自 developtools_hdc 源码） ----------------
USB_HEAD_SIZE = 11
USB_OPTION_HEADER = 1
PACKET_FLAG = b"HW"
BANNER = b"OHOS HDC"
VER_PROTOCOL = 0x01
VCODE = 0x09
EP_IN, EP_OUT, INTERFACE = 0x81, 0x01, 0

CMD_HANDSHAKE = 1
CMD_UNITY_EXECUTE = 1001
AUTH_NONE, AUTH_TOKEN, AUTH_SIGNATURE, AUTH_PUBLICKEY, AUTH_OK = 0, 1, 2, 3, 4
AUTH_NAMES = {0: "NONE", 1: "TOKEN", 2: "SIGNATURE", 3: "PUBLICKEY", 4: "OK", 5: "FAIL"}

TIMEOUT = -7
ERR = {0: "OK", -1: "IO", -2: "INVALID_PARAM", -3: "ACCESS", -4: "NO_DEVICE",
       -5: "NOT_FOUND", -6: "BUSY", -7: "TIMEOUT", -8: "OVERFLOW", -9: "PIPE"}


def log(m):
    print(m, flush=True)


def hexdump(data):
    out = []
    for i in range(0, len(data), 16):
        c = data[i:i + 16]
        out.append(f"  {i:04X}  {' '.join(f'{b:02X}' for b in c):<48}  "
                   f"{''.join(chr(b) if 32 <= b < 127 else '.' for b in c)}")
    return "\n".join(out)


# ---------------- protobuf / 帧构造 ----------------
def varint(n):
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def f_varint(num, val):
    return varint(num * 8) + varint(val)


def f_bytes(num, val):
    return varint(num * 8 + 2) + varint(len(val)) + val


def build_frame(command_flag, payload, channel_id=0, check_sum=0):
    head = (f_varint(1, channel_id) + f_varint(2, command_flag) +
            f_varint(3, check_sum) + f_varint(4, VCODE))
    out = bytearray()
    out += PACKET_FLAG
    out += b"\x00\x00"
    out.append(VER_PROTOCOL)
    out += len(head).to_bytes(2, "big")
    out += len(payload).to_bytes(4, "big")
    out += head + payload
    return bytes(out)


def build_usb_head(session_id, data_size, option=USB_OPTION_HEADER):
    out = bytearray()
    out += b"UB"
    out.append(option)
    out += (session_id & 0xFFFFFFFF).to_bytes(4, "big")
    out += (data_size & 0xFFFFFFFF).to_bytes(4, "big")
    return bytes(out)


def build_handshake(auth_type, session_id, connect_key=b"", buf=b"", version=b"Ver: 3.2.0f"):
    """字段顺序严格按 session.h 的 struct SessionHandShake。"""
    return (f_bytes(1, BANNER) +
            f_varint(2, auth_type) +
            f_varint(3, session_id) +
            f_bytes(4, connect_key) +
            f_bytes(5, buf) +
            f_bytes(6, version))


# ---------------- libusb ----------------
class Usb:
    def __init__(self, dll):
        self.dll = d = ctypes.CDLL(dll)
        d.libusb_init.argtypes = [POINTER(c_void_p)]
        d.libusb_init.restype = c_int
        d.libusb_exit.argtypes = [c_void_p]
        d.libusb_open_device_with_vid_pid.argtypes = [c_void_p, c_uint16, c_uint16]
        d.libusb_open_device_with_vid_pid.restype = c_void_p
        d.libusb_claim_interface.argtypes = [c_void_p, c_int]
        d.libusb_release_interface.argtypes = [c_void_p, c_int]
        d.libusb_bulk_transfer.argtypes = [c_void_p, c_uint8, POINTER(c_uint8),
                                           c_int, POINTER(c_int), c_uint]
        d.libusb_close.argtypes = [c_void_p]
        self.ctx = c_void_p()
        if d.libusb_init(byref(self.ctx)) != 0:
            raise RuntimeError("libusb_init 失败")

    def open(self, vid, pid):
        h = self.dll.libusb_open_device_with_vid_pid(self.ctx, vid, pid)
        if not h:
            raise RuntimeError("打不开设备：先 `hdc kill`，等 1 秒再试")
        return h

    def claim(self, h, i):
        return self.dll.libusb_claim_interface(h, i)

    def release(self, h, i):
        self.dll.libusb_release_interface(h, i)

    def read(self, h, ms=1200):
        buf = (c_uint8 * 4096)()
        n = c_int(0)
        rc = self.dll.libusb_bulk_transfer(h, EP_IN, buf, 4096, byref(n), ms)
        if rc == 0 and n.value:
            return bytes(buf[:n.value])
        return None if rc == TIMEOUT else rc

    def write(self, h, data, ms=2000):
        arr = (c_uint8 * len(data)).from_buffer_copy(data)
        n = c_int(0)
        return self.dll.libusb_bulk_transfer(h, EP_OUT, arr, len(data), byref(n), ms)

    def close(self, h):
        self.dll.libusb_close(h)


def find_libusb(explicit):
    if explicit:
        return explicit
    for c in [
        r"C:\Program Files\Huawei\DevEco Studio\sdk\default\openharmony\toolchains\libusb_shared.dll",
        "libusb_shared.dll", "libusb-1.0.dll",
    ]:
        if os.path.exists(c):
            return c
    raise SystemExit("找不到 libusb，用 --libusb 指定")


def drain(usb, h, seconds, tag, recs):
    """读 seconds 秒，返回期间收到的包列表。顺带学习设备 sessionId。"""
    got = []
    deadline = time.time() + seconds
    while time.time() < deadline:
        pkt = usb.read(h)
        if pkt is None:
            continue
        if isinstance(pkt, int):
            log(f"  [{tag}] read rc={pkt} {ERR.get(pkt, '')}")
            break
        recs.append({"phase": tag, "dir": "IN", "len": len(pkt), "hex": pkt.hex()})
        got.append(pkt)
        log(f"  [{tag}] IN {len(pkt)}B")
        log(hexdump(pkt))
    return got


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--vid", default="12D1")
    ap.add_argument("--pid", default="1101")
    ap.add_argument("--serial", default="")
    ap.add_argument("--libusb", default=None)
    ap.add_argument("--two-transfer", action="store_true",
                    help="UB 头与帧分成两次 bulk 写")
    ap.add_argument("--variant", nargs="*", type=int, default=None)
    ap.add_argument("--out", default="hdc_probe2_log.jsonl")
    args = ap.parse_args()

    vid, pid = int(args.vid, 16), int(args.pid, 16)
    dll = find_libusb(args.libusb)
    log(f"libusb: {dll}")

    recs = []
    usb = Usb(dll)
    h = None
    claimed = False
    try:
        h = usb.open(vid, pid)
        rc = usb.claim(h, INTERFACE)
        if rc != 0:
            log(f"claim 失败 rc={rc} {ERR.get(rc,'')}；先 hdc kill")
            return 2
        claimed = True
        log(f"已 claim interface {INTERFACE}\n")

        log("=== 阶段 0：被动读，学习设备 sessionId ===")
        initial = drain(usb, h, 3.0, "passive", recs)
        dev_sid = 0
        for p in initial:
            if len(p) >= USB_HEAD_SIZE and p[:2] == b"UB":
                dev_sid = int.from_bytes(p[3:7], "big")
                log(f"  学到设备 sessionId = 0x{dev_sid:08X}")
                break
        if not dev_sid:
            log("  未学到设备 sessionId，出站 UB 头将用 0（仍有参考价值）")

        def run(tag, frame, ub_sid, split=False):
            usb_head = build_usb_head(ub_sid, len(frame))
            log(f"\n--- {tag}  UB(sid=0x{ub_sid:08X}) + 帧({len(frame)}B) ---")
            log(hexdump(usb_head + frame))
            if split:
                for chunk in (usb_head, frame):
                    r = usb.write(h, chunk)
                    log(f"  write {len(chunk)}B rc={r} {ERR.get(r,'')}")
                    time.sleep(0.05)
                recs.append({"phase": tag, "dir": "OUT", "split": True,
                             "hex": (usb_head + frame).hex()})
            else:
                r = usb.write(h, usb_head + frame)
                log(f"  write {len(usb_head+frame)}B rc={r} {ERR.get(r,'')}")
                recs.append({"phase": tag, "dir": "OUT", "split": False,
                             "hex": (usb_head + frame).hex()})
            time.sleep(0.2)
            return drain(usb, h, 2.5, tag + "-reply", recs)

        key = args.serial.encode()
        split = args.two_transfer
        variants = [
            (1, "hs auth=NONE sid=0 key=''", build_frame(CMD_HANDSHAKE,
                 build_handshake(AUTH_NONE, 0)), dev_sid),
            (2, "hs auth=NONE sid=0 key=serial", build_frame(CMD_HANDSHAKE,
                 build_handshake(AUTH_NONE, 0, key)), dev_sid),
            (3, "hs auth=SIGNATURE sid=0 key=serial", build_frame(CMD_HANDSHAKE,
                 build_handshake(AUTH_SIGNATURE, 0, key)), dev_sid),
            (4, "hs auth=NONE sid=0 key='' UB.sid=0", build_frame(CMD_HANDSHAKE,
                 build_handshake(AUTH_NONE, 0)), 0),
            (5, "shell via 1001 'shell ls /'", build_frame(CMD_UNITY_EXECUTE,
                 b"shell ls /\x00"), dev_sid),
            (6, "shell via 1001 'ls /'", build_frame(CMD_UNITY_EXECUTE,
                 b"ls /\x00"), dev_sid),
        ]
        if args.variant:
            variants = [v for v in variants if v[0] in args.variant]

        for num, name, frame, sid in variants:
            run(f"V{num} {name}", frame, sid, split)

        log("\n=== 汇总 ===")
        log(f"记录 {len(recs)} 条")
    finally:
        if h is not None:
            if claimed:
                usb.release(h, INTERFACE)
            usb.close(h)
        usb.dll.libusb_exit(usb.ctx)

    with open(args.out, "w", encoding="utf-8") as fh:
        for r in recs:
            fh.write(json.dumps(r, ensure_ascii=False) + "\n")
    log(f"日志：{os.path.abspath(args.out)}")
    log("请回传该 jsonl。若设备异常，拔插一次数据线即可。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
