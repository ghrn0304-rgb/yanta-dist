#!/usr/bin/env python3
# 레퍼런스 룩 재현 — 소스 프레임의 색분포를 레퍼런스 이미지에 맞춰 3D LUT(.cube) 생성.
#   방식(우선순): ① IDT+MKL 하이브리드 — IDT(Pitié, 반복 분포 전송)로 레퍼런스 색 분포의 곡률·디테일을,
#         Zone-MKL(3구간 최적수송)로 계조 매끈함을 얻어 블렌딩 + 격자 스무딩(밴딩 방지). 영화 룩 재현 최상.
#      ② scipy 없으면 IDT 단독 → ③ Reinhard(LAB 통계) 최후 폴백.
#   usage: colortransfer.py <source> <reference> <out.cube> [size=33] [strength=1.0] [preview.png] [film=0]
import sys
import numpy as np
import cv2

try:
    from scipy.linalg import sqrtm
    HAVE_SCIPY = True
except Exception:
    HAVE_SCIPY = False

# 톤 구간 중심 휘도(0..1)와 폭 — 섀도우/미드톤/하이라이트. sigma 넉넉히 겹쳐 부드럽게 블렌딩(밴딩 방지).
ZONE_CENTERS = np.array([0.20, 0.50, 0.80])
ZONE_SIGMA = 0.22


def load_rgb(path):
    img = cv2.imread(path)
    if img is None:
        return None
    return cv2.cvtColor(img, cv2.COLOR_BGR2RGB).astype(np.float64).reshape(-1, 3)


def luma(px255):
    # Rec.709 휘도 (0..255)
    return px255 @ np.array([0.2126, 0.7152, 0.0722])


def zone_weights(px255):
    # 각 픽셀의 휘도 → 3구간 가우시안 가중치(합=1). (N,3)
    L = (luma(px255) / 255.0)[:, None]
    w = np.exp(-((L - ZONE_CENTERS[None, :]) ** 2) / (2 * ZONE_SIGMA * ZONE_SIGMA))
    return w / (w.sum(1, keepdims=True) + 1e-8)


def wstats(px, w):
    # 가중 평균 + 가중 공분산 (해당 톤구간 픽셀 위주).
    s = w.sum() + 1e-8
    m = (px * w[:, None]).sum(0) / s
    d = px - m
    C = (d.T * w) @ d / s + 1e-4 * np.eye(3)
    return m, C


def mkl_T(Cs, Cr):
    Cs_h = sqrtm(Cs).real
    Cs_ih = np.linalg.inv(Cs_h)
    return Cs_ih @ sqrtm(Cs_h @ Cr @ Cs_h).real @ Cs_ih


# ─────────────────────────────────────────────────────────────
# IDT (Iterative Distribution Transfer, Pitié 2007) — 최상위 색전송.
#   랜덤 회전축마다 1D 분위수 매칭을 반복 → 레퍼런스의 [색 분포 전체]에 수렴.
#   Zone-MKL(3구간 평균+공분산)보다 강력: 톤별 색·채도 곡률까지 그대로 복제(영화 룩 재현).
#   분위수 맵은 양끝을 선형 연장 → 소스에 없는 색(격자 모서리)도 부드럽게 외삽(클램프 아티팩트 없음).
IDT_ITERS = 8    # 부분 수렴 — 풀수렴(24+)은 단순 레퍼런스(2색 등)에서 포스터화. 8회면 룩은 강하게, 계조는 매끈하게.
IDT_QN = 64
IDT_MIX = 0.55   # 최종 = IDT 55% + Zone-MKL 45% — 분포 디테일(IDT) + 구조적 매끈함(MKL) 하이브리드.


def _qmap_fit(a, b, qn=IDT_QN):
    # 1D 분위수 매핑 a→b. 반환 (qa, qb) — 적용은 선형보간 + 양끝 기울기 연장.
    qs = np.linspace(0, 100, qn)
    return np.percentile(a, qs), np.percentile(b, qs)


def _qmap_apply(x, qa, qb):
    y = np.interp(x, qa, qb)
    # 범위 밖 선형 연장(identity-safe): 첫/끝 구간 기울기로 외삽.
    lo_slope = (qb[1] - qb[0]) / max(qa[1] - qa[0], 1e-9)
    hi_slope = (qb[-1] - qb[-2]) / max(qa[-1] - qa[-2], 1e-9)
    y = np.where(x < qa[0], qb[0] + (x - qa[0]) * lo_slope, y)
    y = np.where(x > qa[-1], qb[-1] + (x - qa[-1]) * hi_slope, y)
    return y


def fit_idt(src, ref, iters=IDT_ITERS):
    # src를 반복 회전+1D매칭으로 ref 분포에 수렴시키며 변환 체인 기록(격자에 재적용용).
    rng = np.random.default_rng(42)  # 결정적 — 같은 입력이면 같은 LUT
    s = src.copy()
    chain = []
    for _ in range(iters):
        # 랜덤 직교 회전(QR 분해)
        R = np.linalg.qr(rng.normal(size=(3, 3)))[0]
        sp, rp = s @ R.T, ref @ R.T
        maps = []
        for ax in range(3):
            qa, qb = _qmap_fit(sp[:, ax], rp[:, ax])
            sp[:, ax] = _qmap_apply(sp[:, ax], qa, qb)
            maps.append((qa, qb))
        s = sp @ R  # 회전 복귀
        chain.append((R, maps))
    return chain


def apply_idt(px, chain):
    x = px.astype(np.float64).copy()
    for R, maps in chain:
        xp = x @ R.T
        for ax in range(3):
            qa, qb = maps[ax]
            xp[:, ax] = _qmap_apply(xp[:, ax], qa, qb)
        x = xp @ R
    return x


def _sample(px, n=90000, seed=7):
    # 픽셀 다운샘플(속도) — 분포 유지 랜덤 추출.
    if len(px) <= n:
        return px
    idx = np.random.default_rng(seed).choice(len(px), n, replace=False)
    return px[idx]


def smooth_lattice(res, N, passes=2):
    # 33³ 격자 스무딩(binomial [1,2,1] × passes) — IDT의 불연속 매핑(가까운 색이 먼 색으로 갈라짐)을
    #   LUT 연속성으로 강제 완화 → 얼룩·밴딩 방지. 룩(전체 색 방향)은 유지.
    g = res.reshape(N, N, N, 3)
    k = np.array([0.25, 0.5, 0.25])
    for _ in range(passes):
        for axis in range(3):
            g = np.apply_along_axis(lambda m: np.convolve(np.pad(m, 1, mode='edge'), k, mode='valid'), axis, g)
    return g.reshape(-1, 3)


def film_tone(px255, fs):
    # 필름 색과학 근사(Dehancer/FilmBox식) — 색전송 결과에 필름 톤 반응을 얹어 '영화 필름' 느낌.
    #   ① Hable 필모릭 톤커브: 하이라이트 소프트 롤오프(숄더)로 안 날아가고, 섀도우 토우로 딥블랙 방지.
    #   ② 하이라이트 채도 롤오프: 밝을수록 채도↓(실제 필름은 하이라이트에서 색이 옅어짐).
    #   ③ 채널 크로스토크: RGB 소폭 혼합(필름 유제층 색 번짐). fs=필름룩 강도(0=없음).
    if fs <= 0:
        return px255
    x = px255 / 255.0
    A, B, C, D, E, F = 0.22, 0.30, 0.10, 0.20, 0.01, 0.30
    def hable(c):
        return ((c * (A * c + C * B) + D * E) / (c * (A * c + B) + D * F)) - E / F
    fx = hable(x) / hable(1.0)
    L = (fx * np.array([0.2126, 0.7152, 0.0722])).sum(-1, keepdims=True)
    desat = np.clip((L - 0.55) / 0.45, 0.0, 1.0) * 0.35        # 하이라이트 채도 최대 35%↓
    fx = fx * (1.0 - desat) + L * desat
    M = np.eye(3) * 0.96 + 0.0133                              # 미세 크로스토크
    fx = np.clip(fx @ M.T, 0.0, 1.0)
    out = x + (fx - x) * fs                                     # 강도 블렌드
    return np.clip(out, 0.0, 1.0) * 255.0


def identity_grid(N):
    # .cube 순서: R이 가장 빨리 변하고, 그다음 G, B
    axis = np.linspace(0.0, 1.0, N)
    r = np.tile(axis, N * N)
    g = np.tile(np.repeat(axis, N), N)
    b = np.repeat(axis, N * N)
    return np.stack([r, g, b], axis=-1)  # (N^3,3) RGB 0..1


def build_zone_mkl(src, ref):
    # 3구간 각각 가중 MKL 파라미터 (ms, mr, T) 계산.
    sw, rw = zone_weights(src), zone_weights(ref)
    zones = []
    for z in range(3):
        ms, Cs = wstats(src, sw[:, z])
        mr, Cr = wstats(ref, rw[:, z])
        zones.append((ms, mr, mkl_T(Cs, Cr)))
    return zones


def apply_zone_mkl(px255, zones):
    # 픽셀별 휘도 가중으로 3구간 MKL 결과를 블렌딩.
    zw = zone_weights(px255)          # (N,3)
    out = np.zeros_like(px255)
    for z, (ms, mr, T) in enumerate(zones):
        out += zw[:, z:z + 1] * ((px255 - ms) @ T.T + mr)
    return out


def main():
    if len(sys.argv) < 4:
        print("ERROR: usage colortransfer.py source ref out.cube [size] [strength] [preview.png]")
        sys.exit(1)
    src = load_rgb(sys.argv[1])
    ref = load_rgb(sys.argv[2])
    out = sys.argv[3]
    N = int(sys.argv[4]) if len(sys.argv) > 4 else 33
    strength = float(sys.argv[5]) if len(sys.argv) > 5 else 1.0
    film = float(sys.argv[7]) if len(sys.argv) > 7 else 0.0  # 필름룩 강도(0=색전송만, 0.5~1=영화 필름 톤)
    if src is None:
        print("ERROR: source frame load fail"); sys.exit(1)
    if ref is None:
        print("ERROR: reference image load fail"); sys.exit(1)

    g255 = identity_grid(N) * 255.0

    method = None
    zones = None
    chain = None
    # ① IDT(+Zone-MKL 하이브리드) — 분포 디테일은 IDT, 계조 매끈함은 MKL. 격자 스무딩으로 밴딩 방지.
    try:
        chain = fit_idt(_sample(src), _sample(ref))
        idt_g = smooth_lattice(apply_idt(g255, chain), N)
        if HAVE_SCIPY:
            zones = build_zone_mkl(src, ref)
            mkl_g = apply_zone_mkl(g255, zones)
            mapped = idt_g * IDT_MIX + mkl_g * (1.0 - IDT_MIX)
            method = "IDT+MKL"
        else:
            mapped = idt_g
            method = "IDT"
    except Exception:
        method = None
    # ② Zone-MKL 폴백(scipy)
    if method is None and HAVE_SCIPY:
        try:
            zones = build_zone_mkl(src, ref)
            mapped = apply_zone_mkl(g255, zones)
            method = "Zone-MKL"
        except Exception:
            method = None
    if method is None:
        # Reinhard(LAB 평균/표준편차) 전역 폴백
        def lab_stats(rgb):
            bgr = cv2.cvtColor((rgb.reshape(-1, 1, 3)[:, :, ::-1]).astype(np.uint8), cv2.COLOR_BGR2LAB)
            lab = bgr.astype(np.float64).reshape(-1, 3)
            return lab.mean(0), lab.std(0) + 1e-6
        sm, ss = lab_stats(src)
        rm, rs = lab_stats(ref)
        bgr8 = (g255[:, ::-1]).clip(0, 255).astype(np.uint8).reshape(-1, 1, 3)
        lab = cv2.cvtColor(bgr8, cv2.COLOR_BGR2LAB).astype(np.float64).reshape(-1, 3)
        lab = (lab - sm) / ss * rs + rm
        lab = lab.clip(0, 255).astype(np.uint8).reshape(-1, 1, 3)
        mapped = cv2.cvtColor(lab, cv2.COLOR_LAB2BGR).reshape(-1, 3).astype(np.float64)[:, ::-1]
        method = "Reinhard"

    # strength 보간(원본 격자 ↔ 변환 결과) → 필름 톤 반응
    res255 = film_tone((g255 + (mapped - g255) * strength).clip(0, 255), film)
    res = res255.clip(0, 255) / 255.0

    with open(out, "w") as f:
        f.write("# Yanginone reference-look LUT (%s film=%.2f)\n" % (method, film))
        f.write("LUT_3D_SIZE %d\n" % N)
        for px in res:
            f.write("%.6f %.6f %.6f\n" % (px[0], px[1], px[2]))

    # 6번째 인자 = 결과 미리보기 png(소스 프레임에 같은 변환 적용). 다운스케일해 빠르게.
    if len(sys.argv) > 6 and sys.argv[6]:
        simg = cv2.imread(sys.argv[1])
        if simg is not None:
            h, w = simg.shape[:2]
            sc = min(1.0, 640.0 / max(h, w))
            if sc < 1.0:
                simg = cv2.resize(simg, (int(w * sc), int(h * sc)), interpolation=cv2.INTER_AREA)
            srgb = cv2.cvtColor(simg, cv2.COLOR_BGR2RGB).astype(np.float64)
            flat = srgb.reshape(-1, 3)
            if method == "IDT+MKL":
                pm = apply_idt(flat, chain) * IDT_MIX + apply_zone_mkl(flat, zones) * (1.0 - IDT_MIX)
            elif method == "IDT":
                pm = apply_idt(flat, chain)
            elif method == "Zone-MKL":
                pm = apply_zone_mkl(flat, zones)
            else:
                lab = cv2.cvtColor(simg, cv2.COLOR_BGR2LAB).astype(np.float64).reshape(-1, 3)
                lab = (lab - sm) / ss * rs + rm
                lab = lab.clip(0, 255).astype(np.uint8).reshape(simg.shape[0], simg.shape[1], 3)
                pm = cv2.cvtColor(lab, cv2.COLOR_LAB2BGR).reshape(-1, 3)[:, ::-1].astype(np.float64)
            pm = film_tone((flat + (pm - flat) * strength).clip(0, 255), film)
            pm = pm.clip(0, 255).reshape(srgb.shape).astype(np.uint8)
            cv2.imwrite(sys.argv[6], cv2.cvtColor(pm, cv2.COLOR_RGB2BGR))

    print("OK", method, out)


if __name__ == "__main__":
    main()
