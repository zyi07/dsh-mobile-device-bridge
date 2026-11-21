#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
hdc_probe5.py —— 针对 `SendUSBRaw index failed` 的两个假设做对照

已确认的五条（前五轮）：
  · 接口 #0，class 0xFF/0x50/0x01，bulk IN 0x81 / OUT 0x01
  · USBHead(11B) + PayloadHead(11B) + 会话头(protobuf) + 负载
  · R1 UB 头与帧必须**分两次 bulk 写**（合并写 → 被当 softreset，payloadSize:0）
  · R2 version 必须等于 daemon 完整串 `Ver: 3.2.0f73c487f8b34a2ba5`
  · R3 USBHead.sessionId 必须等于 daemon 当前会话 id
        （否则 [CheckPacketOption:165] 判为 softreset 并丢弃负载）
  · 新：daemon 按 **512 字节**分块读 OUT（691B → 512 + 179）

本轮要验证的两个假设（针对 `[SendUSBBlock:91] SendUSBRaw index failed`）：
  H1（主机侧读饥饿）：daemon 回包时主机没有 pending 的 IN URB，导致设备侧写失败。
      → 对策：起一个**常驻读线程**，让 IN 端点始终有未完成的传输。
  H2（会话生命周期）：daemon 仍持有上一次真 hdc 留下的旧会话，我们的帧虽然在
      sid 匹配时进了正确分支，但会话状态已陈旧。
      → 对策：变体 P2（先发 option=RESET 再握手）、P3（等 daemon 会话自然超时后再握手）。

用法（务必先 hdc kill）：
  hdc kill
  python hdc_probe5.py                     # 跑 P1/P2/P4
  python hdc_probe5.py --with-timeout 90   # 额外跑 P3（等 90 秒）
  python hdc_probe5.py --variant 4         # 只跑某个变体

安全：只 claim / bulk / clear_halt / release，不写设备文件。
"""

from __future__ import annotations

import argparse
import ctypes
import json
import os
import queue
import sys
import threading
import time
from ctypes import POINTER, byref, c_int, c_uint, c_uint8, c_uint16, c_void_p

USB_HEAD = 11
OPT_HEADER, OPT_RESET = 1, 2
EP_IN, EP_OUT, IFACE = 0x81, 0x01, 0
VCODE = 0x09
BANNER = b"OHOS HDC"
CMD_HANDSHAKE = 1
AUTH_NONE, AUTH_PUBLICKEY = 0, 3
TIMEOUT, PIPE = -7, -9
ERR = {0: "OK", -1: "IO", -3: "ACCESS", -4: "NO_DEVICE", -6: "BUSY",
       -7: "TIMEOUT", -9: "PIPE", -11: "NO_MEM"}
DAEMON_VERSION = b"Ver: 3.2.0f73c487f8b34a2ba5"


def log(m):
    print(m, flush=True)


def hexdump(d):
    return "\n".join(
        f"  {i:04X}  {' '.join(f'{b:02X}' for b in d[i:i+16]):<48}  "
        f"{''.join(chr(c) if 32 <= c < 127 else '.' for c in d[i:i+16])}"
        for i in range(0, len(d), 16))


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


def fv(n, v):
    return varint(n * 8) + varint(v)


def fb(n, v):
    return varint(n * 8 + 2) + varint(len(v)) + v


def build_frame(flag, payload, channel_id=0):
    head = fv(1, channel_id) + fv(2, flag) + fv(3, 0) + fv(4, VCODE)
    return (b"HW" + b"\x00\x00" + b"\x01" + len(head).to_bytes(2, "big")
            + len(payload).to_bytes(4, "big") + head + payload)


def build_handshake(auth_type, session_id=0, key=b"", buf=b"", version=DAEMON_VERSION):
    return (fb(1, BANNER) + fv(2, auth_type) + fv(3, session_id)
            + fb(4, key) + fb(5, buf) + fb(6, version))


def usb_head(sid, size, option=OPT_HEADER):
    return (b"UB" + bytes([option]) + (sid & 0xFFFFFFFF).to_bytes(4, "big")
            + (size & 0xFFFFFFFF).to_bytes(4, "big"))


def classify(buf):
    """把收到的包判成 heartbeat / handshake / other，避免再把心跳误报成 token。"""
    if len(buf) < USB_HEAD or buf[:2] != b"UB":
        return "non-ub", {}
    size = int.from_bytes(buf[7:11], "big")
    body = buf[USB_HEAD:USB_HEAD + size]
    if body[:2] != b"HW":
        return "ub-no-hw", {"size": size}
    hs = int.from_bytes(body[5:7], "big")
    ds = int.from_bytes(body[7:11], "big")
    head = body[11:11 + hs]
    payload = body[11 + hs:11 + hs + ds]
    # 会话头 protobuf：1=channelId 2=commandFlag 3=checkSum 4=vCode
    flag = None
    i = 0
    while i < len(head):
        key = head[i]; i += 1
        num, wire = key >> 3, key & 7
        if wire == 0:
            v = 0; s = 1
            while True:
                b = head[i]; i += 1
                v += (b & 0x7F) * s
                if not (b & 0x80):
                    break
                s *= 128
            if num == 2:
                flag = v
        elif wire == 2:
            ln = 0; s = 1
            while True:
                b = head[i]; i += 1
                ln += (b & 0x7F) * s
                if not (b & 0x80):
                    break
                s *= 128
            i += ln
        else:
            break
    kind = "heartbeat" if flag == 5000 else ("handshake?" if flag == 1 else f"flag={flag}")
    return kind, {"flag": flag, "headSize": hs, "dataSize": ds, "payload": payload.hex()}


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
        d.libusb_clear_halt.argtypes = [c_void_p, c_uint8]
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

    def clear_halt(self, h, ep):
        try:
            return self.dll.libusb_clear_halt(h, ep)
        except Exception:
            return None

    def read(self, h, ms):
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


class Reader(threading.Thread):
    """常驻读线程：让 IN 端点始终有 pending URB（假设 H1）。"""

    def __init__(self, usb, h):
        super().__init__(daemon=True)
        self.usb, self.h = usb, h
        self.q = queue.Queue()
        self.stop_flag = threading.Event()

    def run(self):
        while not self.stop_flag.is_set():
            p = self.usb.read(self.h, 200)   # 短超时轮转，保证尽快重新挂 URB
            if p is None:
                continue
            if isinstance(p, int):
                if p == PIPE:
                    self.usb.clear_halt(self.h, EP_IN)
                continue
            self.q.put(p)

    def stop(self):
        self.stop_flag.set()
        self.join(timeout=1.0)

    def drain(self, secs):
        out, end = [], time.time() + secs
        while time.time() < end:
            try:
                out.append(self.q.get(timeout=0.05))
            except queue.Empty:
                pass
        return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--vid", default="12D1")
    ap.add_argument("--pid", default="1101")
    ap.add_argument("--libusb", default=None)
    ap.add_argument("--variant", nargs="*", type=int)
    ap.add_argument("--with-timeout", type=int, default=0,
                    help="P3 等多少秒让 daemon 旧会话自然超时（0=不跑 P3）")
    ap.add_argument("--out", default="hdc_probe5_log.jsonl")
    args = ap.parse_args()

    usb = Usb(find_libusb(args.libusb))
    recs = []
    h = None
    claimed = False
    reader = None
    try:
        h = usb.open(int(args.vid, 16), int(args.pid, 16))
        if usb.claim(h, IFACE) != 0:
            log("claim 失败；先 hdc kill")
            return 2
        claimed = True
        reader = Reader(usb, h)
        reader.start()
        log(f"已 claim interface {IFACE}，常驻读线程已启动（H1 对策）\n")

        def collect(secs, tag):
            got = reader.drain(secs)
            for p in got:
                kind, meta = classify(p)
                recs.append({"phase": tag, "dir": "IN", "len": len(p),
                             "kind": kind, "hex": p.hex()})
                log(f"  [{tag}] IN {len(p)}B  → {kind}  {json.dumps(meta, ensure_ascii=False)}")
                if kind != "heartbeat":
                    log(hexdump(p))
            return got

        dev_sid = 0
        log("=== 基线段：被动读 3 秒 ===")
        for p in collect(3.0, "passive"):
            if p[:2] == b"UB" and len(p) >= USB_HEAD:
                dev_sid = int.from_bytes(p[3:7], "big")
        log(f"  设备 sid = 0x{dev_sid:08X}\n")

        def send(tag, sid, auth_type=AUTH_NONE, key=b"", do_reset_first=False):
            if do_reset_first:
                rh = usb_head(sid, 0, OPT_RESET)
                log(f"--- {tag} 先发 RESET(option=2, sid=0x{sid:08X}, len=0) ---")
                log(hexdump(rh))
                log(f"    rc={usb.write(h, rh)}")
                recs.append({"phase": tag, "dir": "OUT", "kind": "reset", "hex": rh.hex()})
                time.sleep(0.5)
                collect(1.0, tag + "-afterreset")

            frame = build_frame(CMD_HANDSHAKE, build_handshake(auth_type, 0, key))
            head = usb_head(sid, len(frame))
            log(f"--- {tag} 握手 authType={auth_type} UB.sid=0x{sid:08X} ---")
            log("  [1/2] UB 头"); log(hexdump(head))
            r1 = usb.write(h, head)
            time.sleep(0.08)
            log(f"  [2/2] 帧 {len(frame)}B"); log(hexdump(frame))
            r2 = usb.write(h, frame)
            log(f"  rc head={r1} frame={r2}")
            recs.append({"phase": tag, "dir": "OUT", "kind": "handshake",
                         "head_hex": head.hex(), "frame_hex": frame.hex()})
            time.sleep(1.2)
            got = collect(4.0, tag + "-reply")
            hits = [classify(p)[0] for p in got]
            log(f"  → 本变体收到: {hits if hits else '无'}\n")
            return got

        want = args.variant
        if not want or 1 in want:
            log("=== P1 sid=0（预期被判 softreset，作为对照）===")
            send("P1", 0)
        if not want or 2 in want:
            log("=== P2 先 RESET 再握手 sid=0 ===")
            send("P2", 0, do_reset_first=True)
        if not want or 4 in want:
            log("=== P4 sid=设备 sid（R3 正确分支）+ 常驻读线程（H1 对策）===")
            send("P4", dev_sid)
        if args.with_timeout and (not want or 3 in want):
            log(f"=== P3 等待 {args.with_timeout}s 让 daemon 旧会话超时，再握手 sid=0 ===")
            collect(args.with_timeout, "P3-wait")
            send("P3", 0)

        log("=== 汇总 ===")
        log(f"记录 {len(recs)} 条；非心跳入站包: "
            f"{[r['kind'] for r in recs if r['dir']=='IN' and r['kind']!='heartbeat']}")
    finally:
        if reader:
            reader.stop()
        if h is not None:
            if claimed:
                usb.release(h, IFACE)
            usb.close(h)
        usb.dll.libusb_exit(usb.ctx)

    with open(args.out, "w", encoding="utf-8") as fh:
        for r in recs:
            fh.write(json.dumps(r, ensure_ascii=False) + "\n")
    log(f"日志：{os.path.abspath(args.out)}")
    log("收尾：`hdc list targets` 应能恢复。")
    return 0


if __name__ == "__main__":
    sys.exit(main())