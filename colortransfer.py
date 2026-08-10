#!/usr/bin/env python3
# 레퍼런스 룩 재현 — 소스 프레임의 색분포를 레퍼런스 이미지에 맞춰 3D LUT(.cube) 생성.
#   방식(우선순): ① IDT+MKL 하이브리드 — IDT(Pitié, 반복 분포 전송)로 레퍼런스 색 분포의 곡률·디테일을,
#         Zone-MKL(3구간 최적수송)로 계조 매끈함을 얻어 블렌딩 + 격자 스무딩(밴딩 방지). 영화 룩 재현 최상.
#      ② scipy 없으면 IDT 단독 → ③ Reinhard(LAB 통계) 최후 폴백.
#   usage: colortransfer.py <source> <reference> <out.cube> [size=33] [strength=1.0] [preview.png] [film=0]
import os
import sys
import numpy as np
import cv2

# [윈도우] 파이프로 내보낼 때 파이썬은 ANSI 코드페이지(한국어면 cp949)를 쓴다. 부르는 쪽은 UTF-8로
#   읽으므로 경로에 한글이 섞이면 글자가 깨진다. 환경변수(PYTHONUTF8)로도 맞추지만, 그게 전달되지
#   않는 경우까지 대비해 여기서도 직접 고정한다.
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass


try:
    from scipy.linalg import sqrtm
    HAVE_SCIPY = True
except Exception:
    HAVE_SCIPY = False

# 톤 구간 중심 휘도(0..1)와 폭 — 섀도우/미드톤/하이라이트. sigma 넉넉히 겹쳐 부드럽게 블렌딩(밴딩 방지).
ZONE_CENTERS = np.array([0.20, 0.50, 0.80])
ZONE_SIGMA = 0.22


# ── 한글 경로 대응 ──────────────────────────────────────────────────────────
# [윈도우 실측 사고] 사용자 이름이 한글이면 임시 폴더가
#   C:\Users\황은선\AppData\Local\Temp\... 가 된다. cv2.imread는 윈도우에서 파일 이름을
#   ANSI 코드페이지로 넘기기 때문에 이런 경로를 못 연다:
#     cv::findDecoder imread_('...\황은선\...png'): can't open/read file: check file path/integrity
#   OpenCV 자체 한계라 경로를 바꾸는 것으로는 못 피한다(사용자 이름을 우리가 정할 수 없다).
#   그래서 파일은 numpy로 읽고 메모리에서 디코드한다. 쓰기도 같은 이유로 encode → tofile.
def imread_any(path, flags=cv2.IMREAD_COLOR):
    try:
        buf = np.fromfile(path, dtype=np.uint8)
    except Exception:
        return None
    if buf.size == 0:
        return None
    return cv2.imdecode(buf, flags)


def imwrite_any(path, img):
    ext = os.path.splitext(path)[1] or ".png"
    ok, buf = cv2.imencode(ext, img)
    if not ok:
        return False
    try:
        buf.tofile(path)
        return True
    except Exception:
        return False


def load_rgb(path):
    img = imread_any(path)
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
#   분위수 맵은 양끝을 [제한된 기울기로] 연장 후 identity로 감쇠 → 소스에 없는 색(격자 모서리)도
#   부드럽게 외삽하되 폭주하지 않음(무제한 선형 연장은 LUT를 단색으로 뭉갬).
IDT_ITERS = 8    # 부분 수렴 — 풀수렴(24+)은 단순 레퍼런스(2색 등)에서 포스터화. 8회면 룩은 강하게, 계조는 매끈하게.
IDT_QN = 64
IDT_MIX = 0.55   # 최종 = IDT 55% + Zone-MKL 45% — 분포 디테일(IDT) + 구조적 매끈함(MKL) 하이브리드.
# 외삽 안전장치 — 소스에 없는 색(격자 모서리)이 폭주해 LUT가 단색으로 뭉개지는 것 방지.
EDGE_KNOTS = 8       # 끝 기울기 추정에 쓰는 분위수 노드 수(인접 2점은 분모≈0 폭주)
SLOPE_MIN, SLOPE_MAX = 0.25, 3.0
EXTRAP_TAU = 40.0    # 0..255 기준 — 범위를 이만큼 벗어나면 기울기가 identity로 수렴
COVER_PASSES = 8     # 소스 색영역 커버리지 스무딩 횟수 — 게이트 경계를 완만하게(밴딩 방지)


def _qmap_fit(a, b, qn=IDT_QN):
    # 1D 분위수 매핑 a→b. 반환 (qa, qb) — 적용은 선형보간 + 양끝 기울기 연장.
    qs = np.linspace(0, 100, qn)
    return np.percentile(a, qs), np.percentile(b, qs)


def _edge_slope(qa, qb, k=EDGE_KNOTS, head=True):
    # 양끝 기울기 — 인접 2노드가 아니라 끝쪽 k개 노드 최소제곱.
    #   인접 2노드는 소스에 평평한 구간(어두운 프레임의 토우 등)이 있으면 분모≈0 → 기울기 폭주.
    a = qa[:k] if head else qa[-k:]
    b = qb[:k] if head else qb[-k:]
    span = a[-1] - a[0]
    s = (b[-1] - b[0]) / span if span > 1e-6 else 1.0
    return float(np.clip(s, SLOPE_MIN, SLOPE_MAX))


def _qmap_apply(x, qa, qb):
    y = np.interp(x, qa, qb)
    # 범위 밖 외삽 — 끝 기울기로 나가되 멀어질수록 기울기를 1(identity)로 감쇠.
    #   무한 선형 연장은 8회 반복·회전 누적으로 격자 모서리를 폭주시켜 LUT 전체가 한 색으로 뭉갬.
    lo_s, hi_s = _edge_slope(qa, qb, head=True), _edge_slope(qa, qb, head=False)
    dlo, dhi = x - qa[0], x - qa[-1]
    wlo = np.exp(-np.abs(dlo) / EXTRAP_TAU)   # 가까우면 끝기울기, 멀면 identity
    whi = np.exp(-np.abs(dhi) / EXTRAP_TAU)
    y = np.where(x < qa[0], qb[0] + dlo * (lo_s * wlo + 1.0 * (1.0 - wlo)), y)
    y = np.where(x > qa[-1], qb[-1] + dhi * (hi_s * whi + 1.0 * (1.0 - whi)), y)
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


def coverage_weight(src255, N, passes=COVER_PASSES):
    # 소스 프레임이 실제로 쓰는 색영역 가중치(격자 노드별 0..1).
    #   색전송 fit은 소스 분포 안에서만 신뢰할 수 있다. 분포 밖 노드(예: 밝은 소스의 완전 검정)는
    #   외삽값이 그대로 박혀 그림자가 통째로 파래지는 사고가 난다 → 커버리지 0인 노드는 identity 유지.
    idx = np.clip(np.rint(src255 / 255.0 * (N - 1)).astype(int), 0, N - 1)
    h = np.zeros((N, N, N))
    np.add.at(h, (idx[:, 2], idx[:, 1], idx[:, 0]), 1.0)   # 축 순서 [b,g,r] = .cube flat 순서와 동일
    k = np.array([0.25, 0.5, 0.25])
    for _ in range(passes):
        for axis in range(3):
            h = np.apply_along_axis(lambda m: np.convolve(np.pad(m, 1, mode='edge'), k, mode='valid'), axis, h)
    pos = h[h > 0]
    ref = np.percentile(pos, 60) if pos.size else 1.0
    return (np.clip(h / (ref + 1e-9), 0.0, 1.0) ** 0.5).reshape(-1)


def apply_lut(px01, grid, N):
    # 생성된 LUT를 트라이리니어로 적용 — 미리보기를 LUT 자체로 만들어 프리미어 결과와 일치시킨다.
    x = np.clip(px01, 0.0, 1.0) * (N - 1)
    i0 = np.floor(x).astype(int)
    i1 = np.minimum(i0 + 1, N - 1)
    f = x - i0
    r0, g0, b0 = i0[:, 0], i0[:, 1], i0[:, 2]
    r1, g1, b1 = i1[:, 0], i1[:, 1], i1[:, 2]
    fr, fg, fb = f[:, 0:1], f[:, 1:2], f[:, 2:3]
    c00 = grid[b0, g0, r0] * (1 - fr) + grid[b0, g0, r1] * fr
    c01 = grid[b0, g1, r0] * (1 - fr) + grid[b0, g1, r1] * fr
    c10 = grid[b1, g0, r0] * (1 - fr) + grid[b1, g0, r1] * fr
    c11 = grid[b1, g1, r0] * (1 - fr) + grid[b1, g1, r1] * fr
    return (c00 * (1 - fg) + c01 * fg) * (1 - fb) + (c10 * (1 - fg) + c11 * fg) * fb


REFINE_PASSES = int(os.getenv("YANTA_REFINE", "3"))  # 폐루프 보정 반복(0=끔). 3회면 수렴
REFINE_DAMP = 0.85    # 보정량 감쇠 — 1.0이면 진동, 0.85면 안정적으로 수렴


def _target_pixels(px255, strength, film, chain, zones, method, sm, ss, rm, rs):
    """LUT를 거치지 않고 변환식을 픽셀에 직접 태운 '정답' 값 (0..1)."""
    if method == "IDT+MKL":
        pm = apply_idt(px255, chain) * IDT_MIX + apply_zone_mkl(px255, zones) * (1.0 - IDT_MIX)
    elif method == "IDT":
        pm = apply_idt(px255, chain)
    elif method == "Zone-MKL":
        pm = apply_zone_mkl(px255, zones)
    else:
        import cv2 as _cv
        bgr8 = (px255[:, ::-1]).clip(0, 255).astype(np.uint8).reshape(-1, 1, 3)
        lab = _cv.cvtColor(bgr8, _cv.COLOR_BGR2LAB).astype(np.float64).reshape(-1, 3)
        lab = ((lab - sm) / ss * rs + rm).clip(0, 255).astype(np.uint8).reshape(-1, 1, 3)
        pm = _cv.cvtColor(lab, _cv.COLOR_LAB2BGR).reshape(-1, 3).astype(np.float64)[:, ::-1]
    out = film_tone((px255 + (pm - px255) * strength).clip(0, 255), film)
    return out.clip(0, 255) / 255.0


def refine_lut(res, src255, strength, film, chain, zones, method, N, sm=None, ss=None, rm=None, rs=None, post=None):
    """소스 픽셀에서 잰 오차를 격자로 되돌려 LUT를 조인다(scattered-data fitting).

    적용값(트라이리니어)과 목표값의 차이를 8개 이웃 노드에 가중 분배 → 노드 평균 오차만큼 이동.
    실제 픽셀이 없는 노드는 건드리지 않으므로 색영역 밖 안전장치(identity)는 그대로 유지된다.
    """
    if src255 is None or len(src255) == 0:
        return res
    grid = res.reshape(N, N, N, 3).copy()
    tgt = _target_pixels(src255, strength, film, chain, zones, method, sm, ss, rm, rs)
    x01 = np.clip(src255 / 255.0, 0.0, 1.0)
    for _ in range(REFINE_PASSES):
        cur = apply_lut(x01, grid, N)
        err = tgt - cur
        if np.abs(err).mean() < 1e-4:
            break
        acc = np.zeros((N, N, N, 3))
        wsum = np.zeros((N, N, N, 1))
        p = x01 * (N - 1)
        i0 = np.floor(p).astype(int)
        i1 = np.minimum(i0 + 1, N - 1)
        f = p - i0
        for dr in (0, 1):
            for dg in (0, 1):
                for db in (0, 1):
                    w = ((f[:, 0] if dr else 1 - f[:, 0])
                         * (f[:, 1] if dg else 1 - f[:, 1])
                         * (f[:, 2] if db else 1 - f[:, 2]))[:, None]
                    ri = i1[:, 0] if dr else i0[:, 0]
                    gi = i1[:, 1] if dg else i0[:, 1]
                    bi = i1[:, 2] if db else i0[:, 2]
                    np.add.at(acc, (bi, gi, ri), err * w)
                    np.add.at(wsum, (bi, gi, ri), w)
        move = np.divide(acc, wsum, out=np.zeros_like(acc), where=wsum > 1e-6)
        grid = np.clip(grid + move * REFINE_DAMP, 0.0, 1.0)
        # 안전 마감(흑점 앵커·계조 단조)을 매 패스마다 걸어 그 제약 안에서 오차를 줄인다.
        #   마지막에 한 번만 걸면 애써 맞춘 값이 다시 틀어진다.
        if post is not None:
            grid = post(grid.reshape(-1, 3)).reshape(N, N, N, 3)
    return grid.reshape(-1, 3)


BLACK_ANCHOR = 0.06   # 입력이 이보다 어두우면 결과도 검정 쪽으로 되돌림(0=끔)


def anchor_black(res, N, radius=BLACK_ANCHOR):
    """거의 검정인 입력은 결과도 검정에 가깝게 — 레퍼런스가 단색이면 그림자까지 물드는 것 방지.

    분포 매칭만 하면 '레퍼런스가 온통 파랑 → 검정도 파랑'이 수학적으로는 맞지만 룩으로는 사고다.
    입력 밝기가 radius 이하인 노드만 부드럽게 identity로 당긴다(경계는 smoothstep이라 밴딩 없음).
    """
    if radius <= 0:
        return res
    ident = identity_grid(N)
    d = ident.max(axis=1)                       # 노드 입력의 최대 채널값 = 밝기 대용
    t = np.clip(d / radius, 0.0, 1.0)
    w = t * t * (3 - 2 * t)                     # smoothstep — 0에서 1로 완만히
    return ident + (res - ident) * w[:, None]


def enforce_monotone_luma(res, N):
    """중성축 밝기가 뒤집힌 곳을 펴준다 — 계조 역전(솔라리제이션·밴딩) 방지.

    커버리지 게이트 경계에서 '변환 구간 → identity 구간'으로 넘어갈 때 밝기가 되레 떨어질 수 있다.
    대각선(회색 계단) 밝기를 누적최대로 단조화하고, 그 차이를 입력 밝기에 따라 전 노드에 더한다.
    채널 균등 보정이라 색(채도·색상)은 건드리지 않는다.
    """
    W = np.array([0.2126, 0.7152, 0.0722])
    ident = identity_grid(N)
    x = ident @ W                                # 노드 입력 밝기 0..1
    steps = np.linspace(0.0, 1.0, N)
    out = res
    # 3회 반복 — 보정이 다른 노드의 순서를 살짝 흔들 수 있어 수렴시킨다.
    for _ in range(3):
        g = out.reshape(N, N, N, 3)
        lum = np.array([g[i, i, i] for i in range(N)]) @ W
        if np.all(np.diff(lum) >= -1e-5):
            break
        # 누적최대(올리기만)는 하이라이트가 1.0에 붙어 있으면 못 올려서 역전이 남는다.
        #   isotonic 회귀는 위아래 양쪽으로 최소제곱 조정 → 값 범위를 안 벗어나 클리핑이 안 생김.
        delta = np.interp(x, steps, _isotonic(lum) - lum)[:, None]
        out = np.clip(out + delta, 0.0, 1.0)
    return out


def _isotonic(y):
    """단조 증가 최소제곱 근사 (PAVA) — 인접 위반 구간을 가중평균으로 합쳐 나간다."""
    stack = []  # (값, 무게, [인덱스들])
    for k, v in enumerate(y):
        cur_v, cur_w, cur_i = float(v), 1.0, [k]
        while stack and stack[-1][0] > cur_v:
            v0, w0, i0 = stack.pop()
            cur_v = (v0 * w0 + cur_v * cur_w) / (w0 + cur_w)
            cur_w += w0
            cur_i = i0 + cur_i
        stack.append((cur_v, cur_w, cur_i))
    out = np.empty(len(y))
    for v, _w, idxs in stack:
        out[idxs] = v
    return out


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

    # 커버리지 게이트 — 소스에 없는 색은 색전송 결과 대신 원본 유지(외삽 오차가 LUT에 박히는 것 차단)
    mapped = g255 + (mapped - g255) * coverage_weight(_sample(src), N)[:, None]

    # strength 보간(원본 격자 ↔ 변환 결과) → 필름 톤 반응
    res255 = film_tone((g255 + (mapped - g255) * strength).clip(0, 255), film)
    res = res255.clip(0, 255) / 255.0

    # [폐루프 보정] 여기까지는 '격자에 변환식을 태운' 개루프 결과다.
    #   실제로 화면에 나오는 건 그 격자를 트라이리니어 보간한 값이라, 격자 스무딩·보간 때문에
    #   원하던 색과 미세하게 어긋난다. 소스 픽셀에 LUT를 실제로 적용해 보고
    #   목표값과의 오차를 격자 노드로 되돌려 몇 번 조인다 → 이 영상에서 룩이 실측으로 맞음.
    # 안전 마감 — 룩의 방향은 그대로 두고 '무너지는 방식'만 막는다.
    #   흑점 앵커: 그림자가 레퍼런스 색으로 물드는 것 방지 / 단조화: 계조 역전(솔라리제이션) 방지.
    def _safe(flat):
        return enforce_monotone_luma(anchor_black(flat, N), N)

    res = _safe(res)
    res = refine_lut(res, _sample(src, 40000), strength, film, chain, zones, method, N,
                     sm if method == "Reinhard" else None, ss if method == "Reinhard" else None,
                     rm if method == "Reinhard" else None, rs if method == "Reinhard" else None,
                     post=_safe)

    with open(out, "w", encoding="utf-8") as f:
        f.write("# Yanginone reference-look LUT (%s film=%.2f)\n" % (method, film))
        f.write("LUT_3D_SIZE %d\n" % N)
        for px in res:
            f.write("%.6f %.6f %.6f\n" % (px[0], px[1], px[2]))

    # 6번째 인자 = 결과 미리보기 png. **생성된 LUT를 그대로 트라이리니어 적용** —
    #   변환식을 따로 태우면(예전 방식) 미리보기는 소스 색영역 안에서만 계산돼 멀쩡한데
    #   프리미어는 격자 전체를 쓰므로 결과가 달라진다(파란 화면 사고). LUT로 미리보기 = WYSIWYG.
    if len(sys.argv) > 6 and sys.argv[6]:
        simg = imread_any(sys.argv[1])
        if simg is not None:
            h, w = simg.shape[:2]
            sc = min(1.0, 640.0 / max(h, w))
            if sc < 1.0:
                simg = cv2.resize(simg, (int(w * sc), int(h * sc)), interpolation=cv2.INTER_AREA)
            srgb = cv2.cvtColor(simg, cv2.COLOR_BGR2RGB).astype(np.float64) / 255.0
            grid = res.reshape(N, N, N, 3)   # flat(R 최속) → [b,g,r]
            pm = apply_lut(srgb.reshape(-1, 3), grid, N)
            pm = (pm.clip(0, 1) * 255.0).reshape(srgb.shape).astype(np.uint8)
            imwrite_any(sys.argv[6], cv2.cvtColor(pm, cv2.COLOR_RGB2BGR))

    print("OK", method, out)


if __name__ == "__main__":
    main()
