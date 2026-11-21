#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
hdc_probe8.py —— 把「真 hdc 抓包里的第 1 帧」原样重放（libusb 直连，不经浏览器）

目的：把「协议是否正确」与「WebUSB 是否有额外问题」彻底分开。
      浏览器侧一直拿不到应答，这里用真机验证过的字节原样发一遍。

两个变量：
  V1  sid = 抓包里的 0x25EF0DC9（与帧内 f3 一致）
  V2  sid = 现场随机（验证 daemon 是否接受新会话 id）

每个变量都先发 RESET 再发帧，然后读 5 秒并打印全部入站数据。

用法（先 hdc kill）：
  hdc kill
  python hdc_probe8.py
"""

from __future__ import annotations
import argparse, ctypes, os, random, sys, time
from ctypes import POINTER, byref, c_int, c_uint, c_uint8, c_uint16, c_void_p

# 真机抓到的第 1 帧（180 字节，逐字节来自 hdc.exe 的 libusb 代理日志）
STEP1_FRAME = "48570000010008000000A108001001180020090A084F484F5320484443100018C99BBCAF022210445348444556494345303030303030312A5E617574687479706520202020202020203120202020202020202020202020202031737570706F7274666561747572657320323920202020202020202020202020205665723A20332E322E30662C5553422C77696E2C686561727462656174321B5665723A20332E322E306637336334383766386233346132626135"

CAPTURED_SID = 636423625          # 0x25EF0DC9
EP_IN, EP_OUT, IFACE = 0x81, 0x01, 0
USB_HEAD = 11
AUTH_NAMES = {0: "NONE", 1: "TOKEN", 2: "SIGNATURE", 3: "PUBLICKEY", 4: "OK", 5: "FAIL"}


def log(m=""):
    print(m, flush=True)


def hexdump(d):
    return "\n".join(
        f"  {i:04X}  {' '.join(f'{b:02X}' for b in d[i:i+16]):<48}  "
        f"{''.join(chr(c) if 32 <= c < 127 else '.' for c in d[i:i+16])}"
        for i in range(0, len(d), 16))


def usb_head(sid, size, option=1):
    return (b"UB" + bytes([option]) + (sid & 0xFFFFFFFF).to_bytes(4, "big")
            + (size & 0xFFFFFFFF).to_bytes(4, "big"))


def varint(b, i):
    v = 0; s = 1
    while True:
        c = b[i]; i += 1
        v += (c & 0x7F) * s
        if not (c & 0x80):
            return v, i
        s *= 128


def parse_frame(b):
    """尽力解析；失败返回 None，不影响 hexdump。"""
    try:
        body = b[USB_HEAD:] if b[:2] == b"UB" else b
        if body[:2] != b"HW":
            return None
        hs = int.from_bytes(body[5:7], "big")
        ds = int.from_bytes(body[7:11], "big")
        head, pay = body[11:11 + hs], body[11 + hs:11 + hs + ds]
        fields, i = {}, 0
        while i < len(head):
            k, i = varint(head, i)
            num, wire = k >> 3, k & 7
            if wire == 0:
                v, i = varint(head, i); fields[num] = v
            elif wire == 2:
                ln, i = varint(head, i); fields[num] = head[i:i+ln]; i += ln
            else:
                return None
        out = {"flag": fields.get(2), "sid_in_frame": fields.get(3)}
        if fields.get(2) == 1:      # 握手帧
            f = {}
            i = 0
            while i < len(pay):
                k, i = varint(pay, i)
                num, wire = k >> 3, k & 7
                if wire == 0:
                    v, i = varint(pay, i); f[num] = v
                elif wire == 2:
                    ln, i = varint(pay, i); f[num] = pay[i:i+ln]; i += ln
                else:
                    break
            out["authType"] = f.get(2)
            out["buf_len"] = len(f.get(5) or b"")
            out["buf_head"] = (f.get(5) or b"")[:40].decode("latin1")
        return out
    except Exception as e:
        return {"parse_error": str(e)}


class Usb:
    def __init__(self, dll):
        d = ctypes.CDLL(dll)
        self.dll = d
        d.libusb_init.argtypes = [POINTER(c_void_p)]
        d.libusb_init.restype = c_int
        d.libusb_open_device_with_vid_pid.argtypes = [c_void_p, c_uint16, c_uint16]
        d.libusb_open_device_with_vid_pid.restype = c_void_p
        d.libusb_claim_interface.argtypes = [c_void_p, c_int]
        d.libusb_release_interface.argtypes = [c_void_p, c_int]
        d.libusb_bulk_transfer.argtypes = [c_void_p, c_uint8, POINTER(c_uint8), c_int,
                                           POINTER(c_int), c_uint]
        d.libusb_clear_halt.argtypes = [c_void_p, c_uint8]
        d.libusb_close.argtypes = [c_void_p]
        d.libusb_exit.argtypes = [c_void_p]
        self.ctx = c_void_p()
        if d.libusb_init(byref(self.ctx)) != 0:
            raise SystemExit("libusb_init 失败")

    def open(self, vid, pid):
        h = self.dll.libusb_open_device_with_vid_pid(self.ctx, vid, pid)
        if not h:
            raise SystemExit("打不开设备：先执行 hdc kill 并确认没有别的程序占用")
        return h

    def read(self, h, ms=1000):
        buf = (c_uint8 * 4096)()
        got = c_int(0)
        rc = self.dll.libusb_bulk_transfer(h, EP_IN, buf, 4096, byref(got), ms)
        if rc == 0 and got.value:
            return bytes(buf[:got.value])
        return None if rc == -7 else rc

    def write(self, h, data, ms=2000):
        arr = (c_uint8 * len(data)).from_buffer_copy(data)
        got = c_int(0)
        return self.dll.libusb_bulk_transfer(h, EP_OUT, arr, len(data), byref(got), ms)


def find_dll(p):
    if p:
        return p
    for c in [r"C:\Program Files\Huawei\DevEco Studio\sdk\default\openharmony\toolchains\libusb_shared.dll",
              "libusb_shared.dll", "libusb-1.0.dll"]:
        if os.path.exists(c):
            return c
    raise SystemExit("找不到 libusb，用 --libusb 指定")


def drain(usb, h, secs, tag):
    """读并打印，返回收到的包数。"""
    n = 0
    end = time.time() + secs
    while time.time() < end:
        p = usb.read(h, 300)
        if p is None:
            continue
        if isinstance(p, int):
            if p == -9:
                usb.dll.libusb_clear_halt(h, EP_IN)
            continue
        n += 1
        info = parse_frame(p) or {}
        log(f"  [{tag}] IN {len(p)}B  {info}")
        log(hexdump(p))
    return n


def run(usb, h, sid, label):
    log(f"\n==================== {label} (sid=0x{sid:08X}) ====================")

    log("[0] 先读 0.3 秒，看设备是否在发心跳")
    drain(usb, h, 0.3, "pre")

    log("[1] 发 RESET（UB 头 option=2, len=0）")
    rc = usb.write(h, usb_head(0, 0, option=2))
    log(f"    rc={rc}")
    time.sleep(0.17)

    frame = bytes.fromhex(STEP1_FRAME)
    log(f"[2] 发 UB 头（单独一次写）: sid=0x{sid:08X} len={len(frame)}")
    rc = usb.write(h, usb_head(sid, len(frame)))
    log(f"    rc={rc}")
    time.sleep(0.05)

    log(f"[3] 发帧（单独一次写）{len(frame)}B")
    log(hexdump(frame))
    rc = usb.write(h, frame)
    log(f"    rc={rc}")

    log("[4] 读 5 秒")
    n = drain(usb, h, 5.0, label)
    log(f"    → 收到 {n} 个包" + ("（有回音！）" if n else "（无回音）"))
    return n


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--vid", default="12D1")
    ap.add_argument("--pid", default="1101")
    ap.add_argument("--libusb", default=None)
    args = ap.parse_args()

    usb = Usb(find_dll(args.libusb))
    h = usb.open(int(args.vid, 16), int(args.pid, 16))
    rc = usb.dll.libusb_claim_interface(h, IFACE)
    log(f"claim_interface({IFACE}) rc={rc}")
    if rc != 0:
        log("claim 失败：先 hdc kill（或退出 DevEco / PCManager）")
        return 2

    try:
        n1 = run(usb, h, CAPTURED_SID, "V1 抓包 sid")
        n2 = run(usb, h, random.randint(1, 0xFFFFFFFF), "V2 随机 sid")
        log("\n==================== 汇总 ====================")
        log(f"V1（抓包 sid）回包数: {n1}")
        log(f"V2（随机 sid）回包数: {n2}")
        if n1 or n2:
            log("→ 有回音：协议序列正确，问题在 WebUSB 实现差异（如 alt setting / 时序）")
        else:
            log("→ 无回音：即使原样重放真机字节也没响应，说明 daemon 侧状态或握手前置条件仍缺")
    finally:
        usb.dll.libusb_release_interface(h, IFACE)
        usb.dll.libusb_close(h)
        usb.dll.libusb_exit(usb.ctx)

    log("\n收尾：跑一次 `hdc list targets` 让 hdc 恢复。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
