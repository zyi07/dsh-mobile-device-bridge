#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
hdc_probe3.py —— RESET 先行 + 会话重建序列（第四轮）

为什么这么设计（基于上一轮的关键观测）：
  上一轮发出 USBHead(option=USB_OPTION_RESET=2, dataSize=0) 后，
  **设备心跳立即停止** → 证明 daemon 确实在读 EP 0x01 且正确解析了 USBHead。
  所以"daemon 没在读 OUT"这个结论被推翻；真正卡住的是 RESET 之后
  如何用正确的方式**建立新会话**。

  上一轮把 RESET 放在最后、且中间已经发了一堆（可能被丢弃的）握手，
  失败了也说明不了问题。本轮把顺序反过来：每次先 RESET 清干净，
  立刻紧跟一个握手变体，观察 daemon 是否回应。

序列（每个变体独立，前一个变体结束后重新 RESET）：
  E1  RESET → 握手(UB.sid=0, authType=NONE,  sid=0, key='')
  E2  RESET → 握手(UB.sid=0, authType=NONE,  sid=0, key=serial)
  E3  RESET → 握手(UB.sid=0, authType=SIGNATURE,sid=0, key=serial)
  E4  RESET → 握手(UB.sid=<新学到的>, authType=NONE, sid=0, key=serial)  ← RESET 后重读 sid
  E5  RESET → 帧前不带 UB 头（裸 HW 帧），authType=NONE
  E6  仅 RESET，然后静置 6 秒（观察 daemon 是否自己发起握手）

用法：
  python hdc_probe3.py
  python hdc_probe3.py --variant 1 4

安全：只 claim/bulk/release。RESET 只会清 hdc 会话，不会重启设备
（上一轮已验证：`hdc list targets` 会变 [Empty]，重新 list 即恢复）。
"""

from __future__ import annotations

import argparse
import ctypes
import json
import os
import sys
import time
from ctypes import POINTER, byref, c_int, c_uint, c_uint8, c_uint16, c_void_p

USB_HEAD_SIZE = 11
OPT_HEADER = 1
OPT_RESET = 2
EP_IN, EP_OUT, IFACE = 0x81, 0x01, 0
VCODE = 0x09
BANNER = b"OHOS HDC"
CMD_HANDSHAKE = 1
AUTH_NONE, AUTH_SIGNATURE = 0, 2
AUTH_NAMES = {0: "NONE", 1: "TOKEN", 2: "SIGNATURE", 3: "PUBLICKEY", 4: "OK", 5: "FAIL"}
TIMEOUT = -7
ERR = {0: "OK", -1: "IO", -3: "ACCESS", -4: "NO_DEVICE", -6: "BUSY",
       -7: "TIMEOUT", -9: "PIPE"}


def log(m):
    print(m, flush=True)


def hexdump(d):
    return "\n".join(
        f"  {i:04X}  {' '.join(f'{b:02X}' for b in d[i:i+16]):<48}  "
        f"{''.join(chr(c) if 32 <= c < 127 else '.' for c in d[i:i+16])}"
        for i in range(0, len(d), 16)
    )


def varint(n):
    o = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            o.append(b | 0x80)
        else:
            o.append(b)
            return bytes(o)


def fv(num, v):
    return varint(num * 8) + varint(v)


def fb(num, v):
    return varint(num * 8 + 2) + varint(len(v)) + v


def build_frame(flag, payload, channel_id=0):
    head = fv(1, channel_id) + fv(2, flag) + fv(3, 0) + fv(4, VCODE)
    return (b"HW" + b"\x00\x00" + b"\x01" + len(head).to_bytes(2, "big")
            + len(payload).to_bytes(4, "big") + head + payload)


def build_handshake(auth_type, session_id=0, key=b"", buf=b"", version=b"Ver: 3.2.0f"):
    return (fb(1, BANNER) + fv(2, auth_type) + fv(3, session_id)
            + fb(4, key) + fb(5, buf) + fb(6, version))


def usb_head(sid, size, option=OPT_HEADER):
    return (b"UB" + bytes([option]) + (sid & 0xFFFFFFFF).to_bytes(4, "big")
            + (size & 0xFFFFFFFF).to_bytes(4, "big"))


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
        d.libusb_bulk_transfer.argtypes = [c_void_p, c_uint8, POINTER(c_uint8), c_int,
                                           POINTER(c_int), c_uint]
        d.libusb_close.argtypes = [c_void_p]
        self.ctx = c_void_p()
        if d.libusb_init(byref(self.ctx)) != 0:
            raise RuntimeError("libusb_init failed")

    def open(self, vid, pid):
        h = self.dll.libusb_open_device_with_vid_pid(self.ctx, vid, pid)
        if not h:
            raise RuntimeError("打不开设备：先 `hdc kill` 等 1 秒")
        return h

    def claim(self, h, n):
        return self.dll.libusb_claim_interface(h, n)

    def release(self, h, n):
        self.dll.libusb_release_interface(h, n)

    def read(self, h, ms=1200):
        buf = (c_uint8 * 4096)()
        got = c_int(0)
        rc = self.dll.libusb_bulk_transfer(h, EP_IN, buf, 4096, byref(got), ms)
        if rc == 0 and got.value:
            return bytes(buf[:got.value])
        return None if rc == TIMEOUT else rc

    def write(self, h, d, ms=2000):
        arr = (c_uint8 * len(d)).from_buffer_copy(d)
        got = c_int(0)
        return self.dll.libusb_bulk_transfer(h, EP_OUT, arr, len(d), byref(got), ms)

    def close(self, h):
        self.dll.libusb_close(h)


def find_libusb(p):
    if p:
        return p
    for c in [r"C:\Program Files\Huawei\DevEco Studio\sdk\default\openharmony\toolchains\libusb_shared.dll",
              "libusb_shared.dll", "libusb-1.0.dll"]:
        if os.path.exists(c):
            return c
    raise SystemExit("找不到 libusb，用 --libusb 指定")


def drain(usb, h, secs, tag, recs):
    out = []
    end = time.time() + secs
    while time.time() < end:
        p = usb.read(h)
        if p is None:
            continue
        if isinstance(p, int):
            log(f"  [{tag}] read rc={p} {ERR.get(p,'')}")
            break
        recs.append({"phase": tag, "dir": "IN", "len": len(p), "hex": p.hex()})
        out.append(p)
        log(f"  [{tag}] IN {len(p)}B")
        log(hexdump(p))
    return out


def learn_sid(usb, h, recs, tag="learn"):
    for p in drain(usb, h, 3.0, tag, recs):
        if len(p) >= USB_HEAD_SIZE and p[:2] == b"UB":
            return int.from_bytes(p[3:7], "big")
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--vid", default="12D1")
    ap.add_argument("--pid", default="1101")   # 第一轮实测：hdc 接口与 MTP 同在一个设备 12D1:1101
    ap.add_argument("--serial", default="")
    ap.add_argument("--libusb", default=None)
    ap.add_argument("--variant", nargs="*", type=int)
    ap.add_argument("--out", default="hdc_probe3_log.jsonl")
    args = ap.parse_args()

    vid, pid = int(args.vid, 16), int(args.pid, 16)
    usb = Usb(find_libusb(args.libusb))
    recs = []
    h = None
    claimed = False
    try:
        h = usb.open(vid, pid)
        if usb.claim(h, IFACE) != 0:
            log("claim 失败；先 hdc kill")
            return 2
        claimed = True
        log(f"已 claim interface {IFACE}")

        key = args.serial.encode()

        def reset():
            pkt = usb_head(0, 0, OPT_RESET)
            log("  [reset] 发送 USBHead(option=RESET, len=0)")
            log(hexdump(pkt))
            rc = usb.write(h, pkt)
            log(f"  [reset] rc={rc} {ERR.get(rc,'')}")
            recs.append({"phase": "reset", "dir": "OUT", "hex": pkt.hex()})
            time.sleep(0.6)
            # 丢掉 RESET 期间的重启残留
            drain(usb, h, 1.0, "reset-tail", recs)

        def send(tag, frame, sid, with_head=True):
            data = (usb_head(sid, len(frame)) + frame) if with_head else frame
            log(f"\n--- {tag} sid=0x{sid:08X} head={with_head} total={len(data)}B ---")
            log(hexdump(data))
            rc = usb.write(h, data)
            log(f"  write rc={rc} {ERR.get(rc,'')}")
            recs.append({"phase": tag, "dir": "OUT", "hex": data.hex()})
            time.sleep(0.2)
            return drain(usb, h, 3.0, tag + "-reply", recs)

        want = args.variant

        if not want or 1 in want:
            log("\n=== E1 RESET → 握手(UB.sid=0, AUTH_NONE, key='') ===")
            reset()
            send("E1", build_frame(CMD_HANDSHAKE, build_handshake(AUTH_NONE)), 0)

        if not want or 2 in want:
            log("\n=== E2 RESET → 握手(UB.sid=0, AUTH_NONE, key=serial) ===")
            reset()
            send("E2", build_frame(CMD_HANDSHAKE, build_handshake(AUTH_NONE, 0, key)), 0)

        if not want or 3 in want:
            log("\n=== E3 RESET → 握手(UB.sid=0, AUTH_SIGNATURE, key=serial) ===")
            reset()
            send("E3", build_frame(CMD_HANDSHAKE, build_handshake(AUTH_SIGNATURE, 0, key)), 0)

        if not want or 4 in want:
            log("\n=== E4 RESET → 重读 sid → 握手(UB.sid=新sid, AUTH_NONE, key=serial) ===")
            reset()
            fresh = learn_sid(usb, h, recs, "E4-learn")
            log(f"  RESET 后学到 sid = 0x{fresh:08X}")
            send("E4", build_frame(CMD_HANDSHAKE, build_handshake(AUTH_NONE, 0, key)), fresh)

        if not want or 5 in want:
            log("\n=== E5 RESET → 裸 HW 帧（不带 UB 头）===")
            reset()
            f = build_frame(CMD_HANDSHAKE, build_handshake(AUTH_NONE, 0, key))
            send("E5", f, 0, with_head=False)

        if not want or 6 in want:
            log("\n=== E6 只 RESET，静置 6 秒看 daemon 是否自己发握手 ===")
            reset()
            drain(usb, h, 6.0, "E6-idle", recs)

        log("\n=== 汇总 ===")
        log(f"记录 {len(recs)} 条")
    finally:
        if h is not None:
            if claimed:
                usb.release(h, IFACE)
            usb.close(h)
        usb.dll.libusb_exit(usb.ctx)

    with open(args.out, "w", encoding="utf-8") as fh:
        for r in recs:
            fh.write(json.dumps(r, ensure_ascii=False) + "\n")
    log(f"日志：{os.path.abspath(args.out)}")
    log("收尾：`hdc list targets` 应能恢复；若仍空，`hdc kill` 后再试。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
