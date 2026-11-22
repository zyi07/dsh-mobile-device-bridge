import subprocess, os
SIGNER = "/opt/harmony26/command-line-tools/sdk/default/openharmony/toolchains/lib/hap-sign-tool.jar"
PW = os.environ.get("DSH_SIGN_PW", "")
KS = os.path.join(os.getcwd(), "dsh_signing_store.jks")
CSR = os.path.join(os.getcwd(), "dsh_signing.csr")
if not PW:
    raise SystemExit("缺少 DSH_SIGN_PW")
r1 = subprocess.run(["java", "-jar", SIGNER, "generate-keypair",
                     "-keyAlias", "dsh-key", "-keyPwd", PW,
                     "-keyAlg", "ECC", "-keySize", "NIST-P-256",
                     "-keystoreFile", KS, "-keystorePwd", PW],
                    capture_output=True, text=True)
print("keypair rc=", r1.returncode)
print((r1.stdout or r1.stderr)[-300:])
r2 = subprocess.run(["java", "-jar", SIGNER, "generate-csr",
                     "-keyAlias", "dsh-key", "-keyPwd", PW,
                     "-subject", "C=CN,O=DSH,OU=MobileBridge,CN=dsh-debug",
                     "-signAlg", "SHA256withECDSA",
                     "-keystoreFile", KS, "-keystorePwd", PW, "-outFile", CSR],
                    capture_output=True, text=True)
print("csr rc=", r2.returncode)
print((r2.stdout or r2.stderr)[-300:])
print("keystore:", os.path.getsize(KS) if os.path.exists(KS) else "缺失")
print("csr:", os.path.getsize(CSR) if os.path.exists(CSR) else "缺失")
