/* Yanta CEP 호스트 스크립트 (ExtendScript, ES3).
 *
 * 여기가 "직접 컷편집"의 핵심 — QE DOM 사용:
 *   - clip.razor(tc)        임의 지점 컷 (UXP엔 없음)
 *   - clip.remove(true,...) 리플 삭제
 *
 * CEP 패널(JS)에서 CSInterface.evalScript('yanta_xxx(args)')로 호출.
 * 결과는 항상 JSON 문자열 반환. 입력 객체는 JSON 문자열로 받아 eval 파싱.
 *
 * ⚠️ QE DOM은 비공개/버전 민감. 메서드명이 다르면 이 파일만 조정.
 */

var TPS = 254016000000; // ticks per second (Premiere 고정)

// ── 유틸 ──────────────────────────────────────────────────────────────
function _ok(payloadStr) { return '{"ok":true,"data":' + payloadStr + '}'; }
function _err(msg) { return '{"ok":false,"error":' + _str(String(msg)) + '}'; }
function _num(n) { return (n === null || n === undefined || isNaN(n)) ? 0 : n; }
// JSON 문자열 안전 이스케이프 (개행/탭 포함 — 미처리 시 JSON.parse 깨짐)
function _str(s) {
  return '"' + String(s)
    .replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    .replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t') + '"';
}

function _parse(jsonStr) { return eval('(' + jsonStr + ')'); } // ES3 JSON 파싱

function _activeSeq() {
  // 미디어 캐시/인덱싱 오류 시 app.project.activeSequence 접근이 throw할 수 있음 → 방어.
  try {
    if (!app.project || !app.project.activeSequence) return null;
    return app.project.activeSequence;
  } catch (e) { return null; }
}

// trackItem 시간 필드(.inPoint/.start 등)의 .seconds 안전 추출 — 오프라인/캐시 클립 방어.
function _safeSec(item, field) {
  try { var t = item[field]; return (t && typeof t.seconds === 'number') ? t.seconds : 0; }
  catch (e) { return 0; }
}

function _tpf() { // ticks per frame
  var seq = _activeSeq();
  try { var t = Number(seq.getSettings().videoFrameRate.ticks); if (t > 0) return t; } catch (e) {}
  return TPS / 30;
}
function _fpsExact() { return TPS / _tpf(); }       // 예: 29.97003 (반올림 X)
function _fps() { return Math.round(_fpsExact() * 1000) / 1000; } // 표시용

// ── 프레임 정확 변환 — 1프레임도 안 밀리게 모든 위치를 프레임 격자에 스냅 ──
// 초 → 프레임 경계 ticks 문자열. Math.round(sec*TPS)는 임의 tick(프레임 사이)에 떨어져 드리프트 →
// 가장 가까운 프레임의 정확한 ticks(frame*tpf)로 스냅. tpf=프레임당 ticks(정수, NTSC도 정확).
function _frameTicks(sec) {
  var tpf = _tpf();
  var frame = Math.round((Number(sec) || 0) * TPS / tpf);
  return String(frame * tpf);
}
// 초를 프레임 경계로 스냅한 초값(이동 델타 계산용).
function _snapSec(sec) {
  var tpf = _tpf();
  return (Math.round((Number(sec) || 0) * TPS / tpf) * tpf) / TPS;
}
function _frameDurSec() { return _tpf() / TPS; }    // 1프레임 길이(초)

// 29.97 / 59.94 → 드롭프레임(Premiere 기본). 23.976/24/25/30/50/60 → 논드롭.
function _isDropFrame(fpsExact) {
  var nominal = Math.round(fpsExact);
  return (Math.abs(fpsExact - nominal) > 0.001) && (nominal === 30 || nominal === 60);
}

function _pad(n) { return (n < 10 ? '0' : '') + n; }

// 초 → 시퀀스 타임코드 (QE razor 입력).
// 1순위: Premiere 네이티브 포맷(Time.getFormatted) — 시퀀스 DF/NDF 설정을 정확 반영
//        (pymiere 검증: razor용 timecode = time.getFormatted(videoFrameRate, videoDisplayFormat))
// 폴백: 직접 SMPTE 계산(DF/NDF).
function _secToTc(sec, fpsExact) {
  try {
    var seq = _activeSeq();
    var st = seq.getSettings();
    var t = new Time();
    t.seconds = sec;
    var nativeTc = t.getFormatted(st.videoFrameRate, st.videoDisplayFormat);
    if (nativeTc) return nativeTc;
  } catch (e) {}
  if (!fpsExact) fpsExact = _fpsExact();
  var nominal = Math.round(fpsExact);
  var frame = Math.round(sec * fpsExact);
  if (!_isDropFrame(fpsExact)) {
    var ff = frame % nominal, s = Math.floor(frame / nominal);
    return _pad(Math.floor(s / 3600)) + ':' + _pad(Math.floor((s % 3600) / 60)) + ':' + _pad(s % 60) + ':' + _pad(ff);
  }
  // SMPTE 드롭프레임 (29.97/59.94): 매 분 drop 프레임 스킵, 10분째는 예외
  var drop = Math.round(fpsExact * 0.066666);        // 30→2, 60→4
  var fp24h = Math.round(fpsExact * 3600) * 24;
  var fp10m = Math.round(fpsExact * 600);            // 실제 fps 기준: 17982 (29.97)
  var fpMin = nominal * 60 - drop;                    // 1798 (30fps)
  frame = frame % fp24h; if (frame < 0) frame += fp24h;
  var d = Math.floor(frame / fp10m);
  var m = frame % fp10m;
  if (m > drop) frame += drop * 9 * d + drop * Math.floor((m - drop) / fpMin);
  else frame += drop * 9 * d;
  var fr = frame % nominal;
  var ss2 = Math.floor(frame / nominal) % 60;
  var mm2 = Math.floor(frame / (nominal * 60)) % 60;
  var hh2 = Math.floor(frame / (nominal * 3600)) % 24;
  return _pad(hh2) + ':' + _pad(mm2) + ':' + _pad(ss2) + ';' + _pad(fr);
}

// QE clip의 시작 초 (버전별 속성 방어)
function _qeClipSec(clip, fps) {
  try {
    if (clip.start && clip.start.secs !== undefined) return Number(clip.start.secs);
    if (clip.start && clip.start.ticks !== undefined) return Number(clip.start.ticks) / TPS;
    // 타임코드 문자열
    var tc = String(clip.start);
    var parts = tc.split(/[:;]/);
    if (parts.length === 4) {
      return Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number(parts[2]) + Number(parts[3]) / fps;
    }
  } catch (e) {}
  return -1;
}

// ── 시퀀스 정보 ───────────────────────────────────────────────────────
function yanta_getSequenceInfo() {
  var seq = _activeSeq();
  if (!seq) return _ok('null');
  var dur = 0;
  try { if (seq.end !== undefined) dur = Number(seq.end) / TPS; } catch (e) {}
  if (!dur || isNaN(dur)) {
    // 폴백: 비디오 트랙 클립 최대 end
    try {
      for (var vt = 0; vt < seq.videoTracks.numTracks; vt++) {
        var trk = seq.videoTracks[vt];
        for (var ci = 0; ci < trk.clips.numItems; ci++) {
          var ce = trk.clips[ci].end.seconds;
          if (ce > dur) dur = ce;
        }
      }
    } catch (e2) {}
  }
  var json = '{' +
    '"id":' + _str(seq.sequenceID) + ',' +
    '"name":' + _str(seq.name) + ',' +
    '"duration":' + _num(dur) + ',' +
    '"videoTrackCount":' + _num(seq.videoTracks ? seq.videoTracks.numTracks : 0) + ',' +
    '"audioTrackCount":' + _num(seq.audioTracks ? seq.audioTracks.numTracks : 0) + ',' +
    '"frameRate":' + _num(_fps()) +
  '}';
  return _ok(json);
}

function yanta_getPlayhead() {
  var seq = _activeSeq();
  if (!seq) return _ok('0');
  var sec = 0;
  try { sec = seq.getPlayerPosition().seconds; } catch (e) {}
  return _ok(String(sec));
}

function yanta_setPlayhead(sec) {
  var seq = _activeSeq();
  if (!seq) return _err('no sequence');
  try { seq.setPlayerPosition(_frameTicks(sec)); return _ok('true'); }
  catch (e) { return _err(e); }
}

function yanta_getVideoClips() {
  var seq = _activeSeq();
  if (!seq) return _ok('[]');
  var out = [];
  try {
    for (var t = 0; t < seq.videoTracks.numTracks; t++) {
      var track = seq.videoTracks[t];
      for (var c = 0; c < track.clips.numItems; c++) {
        var clip = track.clips[c];
        out.push('{"start":' + _num(clip.start.seconds) + ',"end":' + _num(clip.end.seconds) +
          ',"name":' + _str(clip.name) + ',"trackIndex":' + t + '}');
      }
    }
  } catch (e) { return _err(e); }
  return _ok('[' + out.join(',') + ']');
}

// 시퀀스 클립의 원본 미디어 경로들 (STT/무음용 — Node ffmpeg가 직접 읽음)
function yanta_getMediaPaths() {
  var seq = _activeSeq();
  if (!seq) return _ok('[]');
  var seen = {}; var out = [];
  try {
    for (var t = 0; t < seq.audioTracks.numTracks; t++) {
      var track = seq.audioTracks[t];
      for (var c = 0; c < track.clips.numItems; c++) {
        var mp = track.clips[c].projectItem;
        if (mp && mp.getMediaPath) {
          var p = mp.getMediaPath();
          if (p && !seen[p]) { seen[p] = 1; out.push(_str(p)); }
        }
      }
    }
  } catch (e) { return _err(e); }
  return _ok('[' + out.join(',') + ']');
}

// 오디오 트랙별 클립 — 오토믹싱 RMS 분석용. Node ffmpeg가 mediaPath의 [srcIn..] 구간 볼륨 측정.
//  track: 0-based 오디오 트랙. start/end: 타임라인 초. inPoint: 소스 인점 초.
//  → 세그먼트 타임라인T의 소스시간 = inPoint + (T - start). disabled: 현재 비활성 여부.
// 오디오 트랙 클립 일괄 읽기 — 잠긴/빈/중첩/속성없는 트랙·클립은 멈추지 말고 continue로 패스.
//   단일 클립 예외가 전체를 죽이지 않음(사일런트 크래시 방지). MAXCLIPS로 폭주 방어.
function yanta_getAudioTrackClips() {
  var seq = _activeSeq();
  if (!seq) return _ok('[]');
  var out = [];
  var MAXCLIPS = 60000, n = 0, skippedTracks = 0, skippedClips = 0;
  var nTracks = 0;
  try { nTracks = seq.audioTracks.numTracks; }
  catch (e0) { return _err('audioTracks 접근 불가: ' + e0); } // 치명 — 명확히 에러 반환
  for (var t = 0; t < nTracks; t++) {
    var track = null;
    try { track = seq.audioTracks[t]; } catch (et) { skippedTracks++; continue; } // 잠긴/이상 트랙
    if (!track) { skippedTracks++; continue; }
    var nItems = 0;
    try { nItems = track.clips.numItems; } catch (ec) { skippedTracks++; continue; } // 빈/속성없는 트랙
    for (var c = 0; c < nItems; c++) {
      if (n >= MAXCLIPS) break;
      try {
        var clip = track.clips[c];
        if (!clip) { skippedClips++; continue; }
        var st = 0, en = 0;
        try { st = Number(clip.start.seconds); en = Number(clip.end.seconds); }
        catch (ese) { skippedClips++; continue; }       // 시간 속성 없는 클립(중첩 등)
        if (!(en > st)) { skippedClips++; continue; }
        var mp = ''; try { if (clip.projectItem && clip.projectItem.getMediaPath) mp = clip.projectItem.getMediaPath(); } catch (e1) {}
        var ip = 0; try { ip = Number(clip.inPoint.seconds); } catch (e2) {}
        var dis = false; try { dis = !!clip.disabled; } catch (e3) {}
        // 안정 식별자 = 트랙 + 시작틱(컷편집된 타임라인서 클립 고유). disable 적용 시 재매칭용.
        var stk = ''; try { stk = String(clip.start.ticks); } catch (e4) { stk = String(Math.round(st * 254016000000)); }
        var cid = t + ':' + stk;
        out.push('{"id":' + _str(cid) + ',"track":' + t + ',"clipIndex":' + c + ',"start":' + _num(st) + ',"end":' + _num(en) +
          ',"inPoint":' + _num(ip) + ',"disabled":' + (dis ? 'true' : 'false') + ',"path":' + _str(mp) + '}');
        n++;
      } catch (eclip) { skippedClips++; continue; }       // 어떤 클립 예외도 전체 중단 안 함
    }
    if (n >= MAXCLIPS) break;
  }
  // 부분 성공이라도 반환(프리징 대신). 디버그용 메타는 무시 가능.
  return _ok('[' + out.join(',') + ']');
}

// 오토믹싱 적용 — [{id,disabled}] 받아 클립 enable/disable 일괄 처리. id = 트랙:시작틱(getAudioTrackClips와 동일).
//   Mic Bleed: 패자 disabled=true, 승자/단독/crosstalk disabled=false. 재실행 시 정확 갱신(승자 다시 켜짐).
function yanta_setClipsDisabled(jsonStr) {
  var arr; try { arr = _parse(jsonStr); } catch (e) { return _err('bad json'); }
  var seq = _activeSeq();
  if (!seq) return _err('no sequence');
  // id → disabled 맵
  var want = {};
  for (var k = 0; k < arr.length; k++) { if (arr[k] && arr[k].id != null) want[String(arr[k].id)] = !!arr[k].disabled; }
  var changed = 0;
  try {
    var nT = seq.audioTracks.numTracks;
    for (var t = 0; t < nT; t++) {
      var track; try { track = seq.audioTracks[t]; } catch (et) { continue; }
      if (!track) continue;
      var nI = 0; try { nI = track.clips.numItems; } catch (ec) { continue; }
      for (var c = 0; c < nI; c++) {
        var clip; try { clip = track.clips[c]; } catch (e1) { continue; }
        if (!clip) continue;
        var stk = ''; try { stk = String(clip.start.ticks); } catch (e2) { continue; }
        var cid = t + ':' + stk;
        if (!(cid in want)) continue;
        try { if (!!clip.disabled !== want[cid]) { clip.disabled = want[cid]; changed++; } } catch (e3) {}
      }
    }
  } catch (e) { return _err(e); }
  return _ok(String(changed));
}

// 비활성(음소거)된 오디오 클립을 한 번에 삭제 — Mic Bleed로 죽인 클립 정리.
//   remove(false, ...) = [빈자리 남김(lift)]. 뒤 클립을 당기지 않아 다른 트랙과 싱크 보존(비활성=무음이라 무해).
//   뒤에서부터 삭제해 인덱스 밀림 방지.
function yanta_deleteDisabledAudioClips() {
  var seq = _activeSeq();
  if (!seq) return _err('no sequence');
  var removed = 0;
  try {
    var nT = seq.audioTracks.numTracks;
    for (var t = 0; t < nT; t++) {
      var track; try { track = seq.audioTracks[t]; } catch (et) { continue; }
      if (!track) continue;
      var nI = 0; try { nI = track.clips.numItems; } catch (ec) { continue; }
      for (var c = nI - 1; c >= 0; c--) {
        var clip; try { clip = track.clips[c]; } catch (e1) { continue; }
        if (!clip) continue;
        var dis = false; try { dis = !!clip.disabled; } catch (e2) { continue; }
        if (dis) { try { clip.remove(false, false); removed++; } catch (e3) {} }
      }
    }
  } catch (e) { return _err(e); }
  return _ok(String(removed));
}

// ── 효과·모션 프리셋 ───────────────────────────────────────────────────
// 선택 클립의 컴포넌트(Motion=위치·크기·회전·투명도 + 적용된 효과)와 파라미터 값을 읽어 JSON으로.
//   같은 컴포넌트가 대상 클립에 있으면 값 복사(setValue). Motion은 모든 클립에 항상 존재.
function _readClipComponents(clip) {
  var out = [];
  if (!clip || !clip.components) return out;
  for (var k = 0; k < clip.components.numItems; k++) {
    var comp; try { comp = clip.components[k]; } catch (e) { continue; }
    if (!comp || !comp.properties) continue;
    var cname; try { cname = comp.displayName || comp.matchName || ('c' + k); } catch (e2) { cname = 'c' + k; }
    var props = [];
    for (var j = 0; j < comp.properties.numItems; j++) {
      var p; try { p = comp.properties[j]; } catch (e3) { continue; }
      var pn; try { pn = p.displayName || ('p' + j); } catch (e4) { pn = 'p' + j; }
      var v; try { v = p.getValue(); } catch (e5) { continue; }
      if (v === null || typeof v === 'function' || typeof v === 'object' && !(v instanceof Array)) {
        // 배열/원시값만 안전 직렬화. 복합 객체는 스킵.
        if (!(v instanceof Array)) continue;
      }
      props.push({ n: pn, v: v });
    }
    if (props.length) out.push({ c: cname, props: props });
  }
  return out;
}

function _selectedClips(seq) {
  try { var sel = (typeof seq.getSelection === 'function') ? seq.getSelection() : null; return (sel && sel.length) ? sel : null; }
  catch (e) { return null; }
}

function yanta_getClipPreset() {
  var seq = _activeSeq();
  if (!seq) return _err('no sequence');
  var sel = _selectedClips(seq);
  if (!sel) return _err('클립을 먼저 선택하세요 (타임라인에서 클릭)');
  try { return _ok(JSON.stringify(_readClipComponents(sel[0]))); }
  catch (e) { return _err(e); }
}

function yanta_applyClipPreset(jsonStr) {
  var preset; try { preset = _parse(jsonStr); } catch (e) { return _err('bad json'); }
  if (!preset || !preset.length) return _err('빈 프리셋');
  var seq = _activeSeq();
  if (!seq) return _err('no sequence');
  var sel = _selectedClips(seq);
  if (!sel) return _err('적용할 클립을 선택하세요');
  var applied = 0;
  try {
    for (var s = 0; s < sel.length; s++) {
      var clip = sel[s];
      if (!clip || !clip.components) continue;
      for (var pi = 0; pi < preset.length; pi++) {
        var pc = preset[pi];
        for (var k = 0; k < clip.components.numItems; k++) {
          var comp; try { comp = clip.components[k]; } catch (e1) { continue; }
          if (!comp || !comp.properties) continue;
          var cname; try { cname = comp.displayName || comp.matchName; } catch (e2) { continue; }
          if (cname !== pc.c) continue;
          for (var q = 0; q < pc.props.length; q++) {
            var pp = pc.props[q];
            for (var j = 0; j < comp.properties.numItems; j++) {
              var prop; try { prop = comp.properties[j]; } catch (e3) { continue; }
              var pn; try { pn = prop.displayName || ''; } catch (e4) { pn = ''; }
              if (pn === pp.n) { try { prop.setValue(pp.v, true); applied++; } catch (e5) {} break; }
            }
          }
        }
      }
    }
  } catch (e) { return _err(e); }
  return _ok(String(applied));
}

// 선택 클립에 Lumetri Color 효과 적용 시도 (QE) — 버전별 불확실. LUT 파라미터 자동 세팅은 API 한계라
//   효과만 붙이고, 실제 LUT는 사용자가 Lumetri Input LUT에서 파일을 불러오는 폴백을 함께 안내한다.
function yanta_applyLUT(lutPath) {
  try {
    app.enableQE();
    var qseq = (typeof qe !== 'undefined' && qe && qe.project) ? qe.project.getActiveSequence() : null;
    if (!qseq) return _ok('false');
    var eff = null;
    try { eff = qe.project.getVideoEffectByName('Lumetri Color'); } catch (e0) {}
    if (!eff) { try { eff = qe.project.getVideoEffectByName('루메트리 색상'); } catch (e1) {} }
    if (!eff) return _ok('false');
    var done = 0, nT = 0;
    try { nT = qseq.numVideoTracks; } catch (e2) { nT = 0; }
    for (var t = 0; t < nT; t++) {
      var track; try { track = qseq.getVideoTrackAt(t); } catch (e3) { continue; }
      if (!track) continue;
      var nI = 0; try { nI = track.numItems; } catch (e4) { continue; }
      for (var i = 0; i < nI; i++) {
        var it; try { it = track.getItemAt(i); } catch (e5) { continue; }
        if (!it) continue;
        var seld = false; try { seld = it.isSelected(); } catch (e6) { seld = false; }
        if (seld) { try { it.addVideoEffect(eff); done++; } catch (e7) {} }
      }
    }
    return _ok(done > 0 ? 'true' : 'false');
  } catch (e) { return _ok('false'); }
}

// ── 컷편집 (QE DOM) ───────────────────────────────────────────────────
// 단일 지점 컷 — 모든 비디오/오디오 트랙 razor
function yanta_razorAt(sec) {
  try {
    app.enableQE();
    var qseq = qe.project.getActiveSequence();
    var tc = _secToTc(sec);
    var vi, ai;
    for (vi = 0; vi < qseq.numVideoTracks; vi++) _razorTrack(qseq.getVideoTrackAt(vi), tc);
    for (ai = 0; ai < qseq.numAudioTracks; ai++) _razorTrack(qseq.getAudioTrackAt(ai), tc);
    return _ok('true');
  } catch (e) { return _err(e); }
}

// 오디오 트랙만 razor — Mic Bleed 구간 분할용. cuts=[{track,sec}]. 비디오 클립은 안 건드림.
function yanta_razorAudioAt(jsonStr) {
  var arr; try { arr = _parse(jsonStr); } catch (e) { return _err('bad json'); }
  if (!arr || !arr.length) return _ok('0');
  var done = 0;
  var ug = (typeof app.beginUndoGroup === 'function' && typeof app.endUndoGroup === 'function');
  if (ug) { try { app.beginUndoGroup('Yanta Mic Bleed Razor'); } catch (eu) { ug = false; } }
  try {
    app.enableQE();
    var qseq = qe.project.getActiveSequence();
    var nA = qseq.numAudioTracks;
    for (var i = 0; i < arr.length; i++) {
      var t = Number(arr[i].track), sec = Number(arr[i].sec);
      if (t < 0 || t >= nA || !(sec > 0)) continue;
      try { _razorTrack(qseq.getAudioTrackAt(t), _secToTc(sec)); done++; } catch (e1) {}
    }
  } catch (err) { if (ug) { try { app.endUndoGroup(); } catch (e8) {} } return _err(err); }
  if (ug) { try { app.endUndoGroup(); } catch (e9) {} }
  return _ok(String(done));
}

function _razorTrack(track, tc) {
  if (!track) return;
  // QE 버전별: track.razor(tc) 우선, 없으면 해당 클립.razor(tc)
  try { if (track.razor) { track.razor(tc); return; } } catch (e) {}
  try {
    for (var i = 0; i < track.numItems; i++) {
      var clip = track.getItemAt(i);
      if (clip && clip.razor) { try { clip.razor(tc); } catch (e2) {} }
    }
  } catch (e3) {}
}

// 리플 삭제 (구간 배열) — 역순 처리(앞 좌표 보존)
// 멀티캠 보호 리플 삭제 — 무음/대본컷 공용. [{start,end},...] 초.
// 원칙1(전 트랙): 네이티브 Extract가 모든 video/audio 트랙(멀티캠 외부오디오 A1~A8 포함)을
//   동시에 잘라 같은 길이만큼 당긴다 = 트랙별 드리프트 0, V1과 외부 마이크가 1프레임도 안 밀림.
// 원칙2(동기 ripple): qe sequence.extract = 프리미어 네이티브 Sequence Ripple Delete(시퀀스>추출)와
//   동일 커맨드. 개별 클립 remove+당김(트랙마다 오차) 대신 시퀀스 단위 atomic 처리.
// 원칙3(역순): 뒤(우측) 구간부터 삭제 → 앞 구간 타임코드 불변(인덱스 안 꼬임).
// 모든 비디오·오디오 트랙 타겟팅 강제 ON — Extract는 '타겟된 트랙'에만 작동하므로 전처리 필수.
// classic Track.setTargeted(isTargeted, broadcast). 없으면 무시(extract가 기본 전트랙이면 영향 없음).
function _targetAllTracks(seq) {
  try {
    for (var v = 0; v < seq.videoTracks.numTracks; v++) {
      try { seq.videoTracks[v].setTargeted(true, true); } catch (e1) {}
    }
    for (var a = 0; a < seq.audioTracks.numTracks; a++) {
      try { seq.audioTracks[a].setTargeted(true, true); } catch (e2) {}
    }
  } catch (e) {}
}

function yanta_rippleDeleteSegments(jsonStr) {
  var segs;
  try { segs = _parse(jsonStr); } catch (e) { return _err('bad json'); }
  if (!segs || !segs.length) return _ok('0');
  segs.sort(function (a, b) { return b.start - a.start; }); // 원칙3: 역순(우측부터)
  // 원칙3(메모리 방어): 수천 연산을 단일 Undo 그룹으로 (PPro26은 beginUndoGroup 미지원 → 가드).
  var hasUndoGroup = (typeof app.beginUndoGroup === 'function' && typeof app.endUndoGroup === 'function');
  if (hasUndoGroup) { try { app.beginUndoGroup('Yanta 고속 무음 제거'); } catch (eu) { hasUndoGroup = false; } }
  var done = 0, fb = 0;
  try {
    var cseq = app.project.activeSequence;
    if (!cseq) return _err('no sequence');
    _targetAllTracks(cseq);              // 원칙2: 전 트랙 타겟팅 강제 ON
    app.enableQE();
    var qseq = qe.project.getActiveSequence();
    if (!qseq) return _err('no QE sequence');
    var fps = _fps();
    for (var i = 0; i < segs.length; i++) {
      var s = _snapSec(segs[i].start), e = _snapSec(segs[i].end); // 프레임 스냅
      if (e - s < _frameDurSec()) continue;                       // 1프레임 미만 무시
      var ok = false;
      // 원칙1: 네이티브 Extract(프리미어 자체 C++ 엔진) — 전 트랙 atomic ripple, O(n) 클립이동 폐기.
      try { ok = qseq.extract(_secToTc(s), _secToTc(e)); } catch (ex) { ok = false; }
      if (ok) { done++; continue; }
      // 폴백(extract 미지원 빌드만): 전 V+A 트랙 razor 후 구간 클립 ripple
      _razorSeq(s, fps); _razorSeq(e, fps);
      _removeRange(s, e, fps);
      done++; fb++;
    }
  } catch (err) {
    if (hasUndoGroup) { try { app.endUndoGroup(); } catch (e3) {} }
    return _err(err);
  }
  if (hasUndoGroup) { try { app.endUndoGroup(); } catch (e4) {} }
  return _ok(String(done)); // 호환: 처리한 구간 수
}

function _razorSeq(sec, fps) {
  var qseq = qe.project.getActiveSequence();
  var tc = _secToTc(sec); // exact fps + 드롭프레임 내부 처리
  for (var v = 0; v < qseq.numVideoTracks; v++) _razorTrack(qseq.getVideoTrackAt(v), tc);
  for (var a = 0; a < qseq.numAudioTracks; a++) _razorTrack(qseq.getAudioTrackAt(a), tc);
}

// [start,end) 구간 리플 삭제 — 전 트랙(V+A) razor 후 각 트랙의 구간 클립을 ripple 제거.
// QE는 remove(true,*)=ripple만 지원(remove(false,*)=lift는 "Unknown error" throw, 라이브 확인).
// 모든 비디오·오디오 트랙을 동일하게 처리 → 연속 콘텐츠(마이크 등)는 같은 (end-start)만큼 당겨져
// 영상·외부오디오 싱크 유지. 외부 오디오 클립은 구간 밖이면 보존됨.
// ⚠️ 한 트랙이 [start,end]에 갭(콘텐츠 0)이면 그 트랙만 안 당겨질 수 있음(QE ripple 한계).
//    실사용 컷(무음·군말=말하는 중)은 전 트랙 콘텐츠 있어 정상 동기.
function _removeRange(start, end, fps) {
  var qseq = qe.project.getActiveSequence();
  _removeRangeTracks(qseq, true, start, end, fps);
  _removeRangeTracks(qseq, false, start, end, fps);
}

function _removeRangeTracks(qseq, isVideo, start, end, fps) {
  var n = isVideo ? qseq.numVideoTracks : qseq.numAudioTracks;
  var eps = _frameDurSec() * 0.5 + 0.0005;
  for (var ti = 0; ti < n; ti++) {
    var track = isVideo ? qseq.getVideoTrackAt(ti) : qseq.getAudioTrackAt(ti);
    if (!track) continue;
    var removedAny = true, guard = 0;
    while (removedAny && guard < 100000) {
      removedAny = false; guard++;
      for (var i = 0; i < track.numItems; i++) {
        var clip = track.getItemAt(i); if (!clip) continue;
        var cs = _qeClipSec(clip, fps); if (cs < 0) continue;
        if (cs >= start - eps && cs < end - eps) {
          try { clip.remove(true, false); removedAny = true; } catch (e2) {} // ripple delete(=좌측 당김)
          break; // numItems 변동 → 재스캔
        }
      }
    }
  }
}

// 단일 구간 리플 삭제
function yanta_rippleDelete(start, end) {
  return yanta_rippleDeleteSegments('[{"start":' + start + ',"end":' + end + '}]');
}

// ── 시퀀스 오디오 export (STT용 전체 믹스) ────────────────────────────
// Premiere 내장 WAV 프리셋으로 시퀀스 전체(또는 in/out) 오디오를 직접 렌더.
// (Cutback 검증 패턴 — 클립 원본 대신 실제 믹스다운)
// 26.2 프리셋 경로: app.path + 'Contents/Settings/EncoderPresets/*.epr'
//   STT엔 모노 16kHz가 최적(WAV_Mono_16bit_16kHz). 없으면 다른 WAV로 폴백.
// [Windows에서 못 찾던 이유] 예전 코드는 app.path + 'Contents/Settings/EncoderPresets/' 만 봤다.
//   'Contents/'는 macOS 앱 번들에만 있는 폴더다. 윈도우 설치본은
//   C:\Program Files\Adobe\Adobe Premiere Pro 2026\Settings\EncoderPresets\ 처럼 Contents가 없어서
//   항상 못 찾고 "WAV 인코더 프리셋(.epr)을 찾을 수 없음"으로 끝났다(윈도우 배포본 실제 신고).
//   그래서 이제 두 배치를 모두 보고, 이름이 다를 수 있으니 폴더를 훑어 WAV 프리셋을 찾는다.

/**
 * 폴더를 만든다 — 중간 폴더까지. 있으면 그대로 참.
 *
 * [왜 한 단계씩 만드나] ExtendScript의 Folder.create()가 중간 폴더까지 만들어 주는지는
 *   버전마다 미덥지 않다. 여기서 실패하면 조용히 한글 임시 폴더로 되돌아가고, 그다음에
 *   whisper.cpp가 그 경로를 못 열어 [음성 인식 실패]로만 보인다 — 원인이 여기라는 걸 알 수 없다.
 *   한 단계씩 만들면 어느 구현에서도 같게 동작한다.
 */
function _mkdirs(path) {
  var parts = String(path).replace(/\\/g, '/').replace(/\/+$/, '').split('/');
  var cur = '';
  for (var i = 0; i < parts.length; i++) {
    cur = cur ? cur + '/' + parts[i] : parts[i];
    if (!cur || /^[A-Za-z]:$/.test(cur)) continue;   // 드라이브 문자만으론 폴더가 아니다
    try {
      var f = new Folder(cur);
      if (!f.exists) f.create();
    } catch (e) { /* 다음 단계에서 exists로 확인한다 */ }
  }
  try { return new Folder(path).exists; } catch (e2) { return false; }
}

/** 프리셋이 있을 만한 폴더 목록. 찾기 실패 시 이 목록을 오류 문구에 넣어 확인할 수 있게 한다. */
function _wavPresetDirs() {
  // 윈도우의 app.path는 'C:\Program Files\...\Adobe Premiere Pro 2026\' 처럼 역슬래시로 끝난다.
  //   그대로 두고 '/'를 덧붙이면 '...2026\/Settings/...' 가 되어 폴더를 못 찾는다.
  //   구분자를 '/'로 통일하고 끝의 슬래시를 하나로 맞춘다.
  var base = String(app.path).replace(/\\/g, '/').replace(/\/+$/, '') + '/';
  var roots = [base, base + 'Contents/'];
  try {
    var up = new Folder(base).parent;                 // app.path가 실행파일 폴더를 가리키는 경우 대비
    if (up && up.absoluteURI) {
      roots.push(String(up.absoluteURI) + '/');
      // [옆에 깔린 Adobe 제품도 본다] 프리셋을 들고 있는 쪽이 Premiere가 아니라
      //   Media Encoder인 설치본이 있다. 둘은 'C:\Program Files\Adobe' 아래 형제 폴더라
      //   parent만 봐서는 닿지 않는다. 이름이 'Adobe …'인 형제를 전부 뿌리에 넣는다.
      var sibs = [];
      try { sibs = up.getFiles(function (f) { return f instanceof Folder; }) || []; } catch (eS) {}
      for (var b = 0; b < sibs.length; b++) {
        var su = String(sibs[b].absoluteURI) + '/';
        if (su !== base && /adobe/i.test(String(sibs[b].name))) roots.push(su);
      }
    }
  } catch (eU) {}

  var subs = ['Settings/EncoderPresets/', 'MediaIO/presets/', 'MediaIO/systempresets/'];
  var out = [];
  for (var r = 0; r < roots.length; r++) {
    for (var s = 0; s < subs.length; s++) out.push(roots[r] + subs[s]);
  }
  // 사용자가 만든 프리셋(Media Encoder) — 내장이 없어도 여기 있을 수 있다.
  try {
    var docs = Folder.myDocuments;
    if (docs && docs.absoluteURI) {
      var ame = new Folder(String(docs.absoluteURI) + '/Adobe/Adobe Media Encoder');
      if (ame.exists) {
        var vers = ame.getFiles(function (f) { return f instanceof Folder; }) || [];
        for (var v = 0; v < vers.length; v++) out.push(String(vers[v].absoluteURI) + '/Presets/');
      }
    }
  } catch (eD) {}
  return out;
}

/** 폴더에서 WAV용 .epr을 고른다. 이름이 정확히 맞는 것 우선, 없으면 이름에 wav/wave가 든 것. */
function _pickWavIn(folder, depth) {
  if (!folder || !folder.exists) return null;
  var names = ['WAV_Mono_16bit_16kHz.epr', 'Wave48mono16.epr', 'Wave48mono24.epr', 'Wave96mono16.epr', 'WAV.epr'];
  for (var n = 0; n < names.length; n++) {
    var f = new File(String(folder.absoluteURI) + '/' + names[n]);
    if (f.exists) return f;
  }
  var kids;
  try { kids = folder.getFiles() || []; } catch (e) { return null; }
  // 이름이 제품 버전마다 달라서 목록만으로는 부족하다 — 훑어서 고른다. 모노를 먼저 고른다(STT에 좋다).
  var best = null;
  for (var i = 0; i < kids.length; i++) {
    var k = kids[i];
    if (k instanceof Folder) {
      if (depth > 0) { var deep = _pickWavIn(k, depth - 1); if (deep) return deep; }
      continue;
    }
    var nm = String(k.name);
    if (!/\.epr$/i.test(nm) || !/wav|wave/i.test(nm)) continue;
    if (/mono/i.test(nm)) return k;
    if (!best) best = k;
  }
  return best;
}

function _findWavPreset() {
  var all = _findWavPresets();
  return all.length ? all[0] : null;
}

/**
 * 쓸 만한 WAV 프리셋을 [여러 개] 찾는다.
 *
 * [왜 여러 개인가] 이름에 wav가 들어 있다고 다 오디오 전용 프리셋은 아니다. 하나만 골라
 *   내보내다 실패하면 "렌더는 됐는데 파일이 없다"로 끝나고, 사람은 무엇이 잘못됐는지 알 수 없다
 *   (윈도우에서 실제로 그렇게 신고됨). 후보를 순서대로 시도해 [파일이 실제로 나온 것]을 쓴다.
 */
function _findWavPresets() {
  var dirs = _wavPresetDirs(), out = [], seen = {};
  for (var d = 0; d < dirs.length; d++) {
    var folder = new Folder(dirs[d]);
    if (!folder.exists) continue;
    var hits = _collectWavIn(folder, 1);
    for (var i = 0; i < hits.length; i++) {
      var fs2 = String(hits[i].fsName);
      if (seen[fs2]) continue;
      seen[fs2] = 1;
      out.push(hits[i]);
      if (out.length >= 6) return out;    // 후보가 너무 많으면 시도가 길어진다
    }
  }
  return out;
}

/** 폴더에서 WAV 후보를 모은다. 모노를 먼저 — STT에 좋다. */
function _collectWavIn(folder, depth) {
  var out = [], mono = [], other = [];
  if (!folder || !folder.exists) return out;
  var names = ['WAV_Mono_16bit_16kHz.epr', 'Wave48mono16.epr', 'Wave48mono24.epr', 'Wave96mono16.epr', 'WAV.epr'];
  for (var n = 0; n < names.length; n++) {
    var f = new File(String(folder.absoluteURI) + '/' + names[n]);
    if (f.exists) out.push(f);
  }
  var kids;
  try { kids = folder.getFiles() || []; } catch (e) { return out; }
  for (var i = 0; i < kids.length; i++) {
    var k = kids[i];
    if (k instanceof Folder) {
      if (depth > 0) { var deep = _collectWavIn(k, depth - 1); for (var j = 0; j < deep.length; j++) other.push(deep[j]); }
      continue;
    }
    var nm = String(k.name);
    if (!/\.epr$/i.test(nm) || !/wav|wave/i.test(nm)) continue;
    if (/mono/i.test(nm)) mono.push(k); else other.push(k);
  }
  for (var a = 0; a < mono.length; a++) out.push(mono[a]);
  for (var b = 0; b < other.length; b++) out.push(other[b]);
  return out;
}

/** 이 시스템이 윈도우인가. ExtendScript는 Folder.fs 로 알려준다('Windows' | 'Macintosh'). */
function _isWin() {
  try { return String(Folder.fs) === 'Windows'; } catch (e) { return false; }
}

/**
 * 네이티브 경로 — 프리미어의 내보내기는 ExtendScript File이 아니라 [OS 경로 문자열]을 받는다.
 * 윈도우에서 슬래시로 넘기면 조용히 아무것도 안 만들 수 있다. 그래서 OS 구분자로 맞춰 준다.
 */
function _nativePath(p) {
  var s = String(p || '');
  return _isWin() ? s.replace(/\//g, '\\') : s.replace(/\\/g, '/');
}

// 내보내기가 끝나기를 기다린다. 못 만들면 null.
//   FIRST_MS: 파일이 생기기까지 기다릴 시간. 이 안에 아무것도 안 생기면 이 프리셋이 틀린 것이다.
//   TOTAL_MS: 다 쓰기까지 기다릴 시간. 패널 쪽 제한(180초)보다 넉넉히 짧게 잡는다.
var _EXPORT_FIRST_MS = 25000, _EXPORT_TOTAL_MS = 140000, _EXPORT_TICK = 500;

function _waitForExport(safePath, safeDir, baseNoExt) {
  var waited = 0, lastSize = -1, stable = 0, found = null;
  while (waited < _EXPORT_TOTAL_MS) {
    var f = new File(safePath);
    if (!(f.exists && f.length > 0)) f = _findMade(safeDir, baseNoExt);   // 확장자가 다를 수 있다
    if (f && f.exists && f.length > 0) {
      found = f;
      // 크기가 두 번 연속 그대로면 다 쓴 것으로 본다.
      if (f.length === lastSize) { stable++; if (stable >= 2) return f; }
      else { stable = 0; lastSize = f.length; }
    } else if (waited >= _EXPORT_FIRST_MS) {
      return null;   // 아직 아무것도 안 생겼다 — 이 프리셋으로는 안 된다
    }
    try { $.sleep(_EXPORT_TICK); } catch (e) { return found; }   // sleep이 없으면 더 못 기다린다
    waited += _EXPORT_TICK;
  }
  return found;   // 시간이 다 됐지만 파일은 있다 — 있는 것을 준다
}

/** 폴더에서 같은 이름(확장자 무관)으로 실제 만들어진 파일을 찾는다. */
function _findMade(dirPath, baseNoExt) {
  try {
    var folder = new Folder(dirPath);
    if (!folder.exists) return null;
    var kids = folder.getFiles() || [];
    for (var i = 0; i < kids.length; i++) {
      var k = kids[i];
      if (k instanceof Folder) continue;
      var nm = String(k.name).replace(/\.[^.]+$/, '');
      if (nm === baseNoExt && k.length > 0) return k;
    }
  } catch (e) {}
  return null;
}

// 환경 진단 한 방 — 프리미어 쪽에서 알 수 있는 것을 한 번에 모은다.
//   개발자가 윈도우를 못 만져 보므로, 쓰는 사람이 이걸 눌러 보내 주는 게 유일한 확인 방법이다.
//   그래서 "무엇이 없다"가 아니라 "어디를 봤고 거기 몇 개가 있었나"까지 담는다.
function yanta_diagEnvironment() {
  var r = { appPath: '', version: '', preset: null, presetDirs: [], mogrtRoots: [], seq: null };
  try { r.appPath = String(app.path); } catch (e1) {}
  try { r.version = String(app.version); } catch (e2) {}
  try {
    var hit = _findWavPreset();
    r.preset = hit ? String(hit.fsName) : null;
    var pd = _wavPresetDirs();
    for (var i = 0; i < pd.length; i++) {
      var f = new Folder(pd[i]), n = -1;
      try { n = f.exists ? (f.getFiles() || []).length : -1; } catch (e3) { n = -2; }
      r.presetDirs.push({ dir: pd[i], n: n });
    }
  } catch (e4) {}
  try {
    var mr = _mogrtRoots();
    for (var m = 0; m < mr.length; m++) {
      var fo = new Folder(mr[m]), cnt = -1;
      try { cnt = fo.exists ? (fo.getFiles() || []).length : -1; } catch (e5) { cnt = -2; }
      r.mogrtRoots.push({ dir: mr[m], n: cnt });
    }
  } catch (e6) {}
  try {
    var s = _activeSeq();
    if (s) r.seq = { name: String(s.name), v: s.videoTracks.numTracks, a: s.audioTracks.numTracks };
  } catch (e7) {}
  return _ok(JSON.stringify(r));
}

// 진단 — 어디를 뒤졌고 무엇을 찾았는지 그대로 보여준다. 윈도우에서 원격으로 확인할 때 쓴다.
function yanta_diagWavPreset() {
  var dirs = _wavPresetDirs(), rows = [];
  for (var d = 0; d < dirs.length; d++) {
    var f = new Folder(dirs[d]), n = 0;
    try { n = f.exists ? (f.getFiles() || []).length : -1; } catch (e) { n = -2; }
    rows.push({ dir: dirs[d], exists: !!f.exists, items: n });
  }
  var hit = _findWavPreset();
  return _ok(JSON.stringify({ appPath: String(app.path), found: hit ? String(hit.fsName) : null, dirs: rows }));
}
function _basename(p) { return String(p).replace(/^.*[\/\\]/, ''); }
function yanta_exportAudio(outputPath, useInOut) {
  var seq = _activeSeq();
  if (!seq) return _err('활성 시퀀스 없음 — Premiere에서 시퀀스를 열어주세요');
  try {
    // [1] Mac 권한 안전 경로 — OS 공식 temp(쓰기권한 보장). 전달 경로의 파일명만 사용.
    //     임의 폴더 하드코딩 금지: Folder.temp → 없으면 Folder.userData 폴백.
    var fileName = _basename(outputPath);
    // 방어: 인자 누락(_basename→'undefined') 또는 .wav 확장자 없으면 안전 기본명(확장자 없으면 export 조용히 실패).
    if (!fileName || fileName === 'undefined' || !/\.wav$/i.test(fileName)) fileName = 'yanta-audio-' + (new Date().getTime()) + '.wav';
    var safeDir = '';
    try { if (Folder.temp && Folder.temp.fsName) safeDir = Folder.temp.fsName; } catch (et) {}
    if (!safeDir) { try { if (Folder.userData && Folder.userData.fsName) safeDir = Folder.userData.fsName; } catch (eu) {} }
    if (!safeDir) safeDir = String(outputPath).replace(/[\/\\][^\/\\]*$/, ''); // 최후 폴백
    // [한글 경로 피하기] 사용자 이름이 한글이면 임시 폴더가 C:\Users\황은선\...\Temp 가 된다.
    //   이 WAV를 받아 여는 건 whisper.cpp 같은 외부 도구인데, 윈도우에서 파일 이름을 ANSI
    //   코드페이지로 다루는 것들은 그런 경로를 못 연다(OpenCV가 실제로 그랬다).
    //   C:\Users\Public 은 어떤 윈도우에도 있고 이름이 항상 ASCII이며 쓸 수 있다.
    if (/[^\x20-\x7E]/.test(safeDir)) {
      var pub = '';
      try { pub = String($.getenv('PUBLIC') || ''); } catch (ep) {}
      if (pub) {
        var alt = pub.replace(/\\/g, '/').replace(/\/+$/, '') + '/Yanginone/tmp';
        if (_mkdirs(alt)) safeDir = alt;
      }
    }
    safeDir = String(safeDir).replace(/\\/g, '/').replace(/\/+$/, '');
    var safePath = safeDir + '/' + fileName;

    // [2a] 프리셋(.epr) 후보 — 하나만 믿지 않는다. 이름에 wav가 있어도 오디오 전용이 아닐 수 있다.
    var presets = _findWavPresets();
    if (!presets.length) {
      // 어디를 뒤졌는지 함께 알린다 — "폴더 확인"만으로는 어느 폴더인지 알 수 없다.
      var tried = _wavPresetDirs();
      return _err('WAV 인코더 프리셋(.epr)을 찾을 수 없음 (Premiere 설치: ' + String(app.path)
        + ' / 찾아본 곳 ' + tried.length + '군데)');
    }

    // [2b] In/Out 검증 — 0초짜리 빈 구간 렌더 방지.
    var workArea;
    if (useInOut) {
      var inP = 0, outP = 0;
      try { inP = Number(seq.getInPoint()); outP = Number(seq.getOutPoint()); } catch (ei) {}
      if (!(outP - inP > 0.05)) return _err('IN/OUT 구간이 비어있음(0초) — 타임라인에 In/Out을 지정하거나 전체 모드로 실행하세요');
      workArea = (app.encoder && app.encoder.ENCODE_IN_TO_OUT != null) ? app.encoder.ENCODE_IN_TO_OUT : 1;
    } else {
      workArea = (app.encoder && app.encoder.ENCODE_ENTIRE != null) ? app.encoder.ENCODE_ENTIRE : 0;
    }

    var baseNoExt = fileName.replace(/\.[^.]+$/, '');

    // [실행] 후보 프리셋을 순서대로 시도해 [파일이 실제로 나온 것]을 쓴다.
    //   반환값은 믿지 않는다 — 성공을 돌려주고도 아무것도 안 만드는 경우가 있다(윈도우 실측 신고).
    var tries = [];
    for (var pi = 0; pi < presets.length; pi++) {
      var preset = presets[pi];
      tries.push(String(preset.name));
      try { var old = new File(safePath); if (old.exists) old.remove(); } catch (er) {}
      try {
        // 경로는 OS 구분자로 넘긴다. 내보내기는 ExtendScript File이 아니라 OS 경로 문자열을 받는다.
        seq.exportAsMediaDirect(_nativePath(safePath), _nativePath(preset.fsName), workArea);
      } catch (eX) { continue; }

      // [기다리는 시간이 핵심] 예전 코드는 내보내기를 부르자마자 파일을 확인했다. 렌더는 시간이
      //   걸리므로 언제나 '없음'이었다 — 윈도우에서 "렌더 호출됐으나 파일 미생성"으로 신고된 것이 이것이다.
      //   5분짜리 시퀀스면 오디오 렌더에 수십 초가 걸린다. 그래서 두 단계로 기다린다:
      //     ① 파일이 [생기기]까지 — 안 생기면 이 프리셋은 틀린 것이니 다음 후보로 넘어간다.
      //     ② 생긴 뒤에는 [크기가 멈출 때]까지 — 쓰는 중인 파일을 넘기면 잘린 소리를 인식하게 된다.
      var made = _waitForExport(safePath, safeDir, baseNoExt);
      if (made) return _ok(_str(String(made.fsName).replace(/\\/g, '/')));
    }

    // 여기까지 왔으면 어느 프리셋으로도 파일이 안 나왔다. 아는 것을 전부 말한다 —
    //   "오디오 트랙이 있는지 확인"만 보여주면, 트랙이 멀쩡히 있는 사람은 다음에 뭘 할지 알 수 없다.
    var aCount = 0, aClips = 0;
    try {
      aCount = seq.audioTracks.numTracks;
      for (var t2 = 0; t2 < aCount; t2++) aClips += seq.audioTracks[t2].clips.numItems;
    } catch (eA) {}
    return _err('렌더는 됐지만 오디오 파일이 안 만들어졌어요 — 저장 위치: ' + safePath
      + ' / 오디오 트랙 ' + aCount + '개·클립 ' + aClips + '개'
      + ' / 시도한 프리셋: ' + tries.join(', '));
  } catch (e) {
    // [3] 두루뭉술 금지 — ExtendScript 실제 에러(message/description)를 그대로 전달.
    var msg = (e && (e.message || e.description)) ? (e.message || e.description) : String(e);
    return _err('오디오 렌더 실패: ' + msg);
  }
}

// 시퀀스 프레임 export(색보정 탭) — 현재 재생헤드(또는 지정 시각) 프레임을 PNG로. 시퀀스 렌더라
//   Lumetri 등 사용자가 적용한 기본 색보정이 반영됨(원본 미디어 프레임과 다름). 네이티브라 빠름.
function yanta_exportSequenceFrame(timeSec, outPath) {
  var seq = _activeSeq();
  if (!seq) return _err('활성 시퀀스 없음 — Premiere에서 시퀀스를 열어주세요');
  try {
    // 지정 시각이면 재생헤드 이동(없으면 현재 위치). QE CTI가 이걸 읽음.
    if (timeSec !== null && timeSec !== undefined && timeSec !== '') {
      try { seq.setPlayerPosition(String(Math.round(Number(timeSec) * 254016000000))); $.sleep(120); } catch (em) {}
    }
    // QE DOM exportFramePNG — CEP Sequence엔 없고 QE엔 있음(mac/win 공통). 시퀀스 렌더라 Lumetri 색보정 반영.
    app.enableQE();
    var q = qe.project.getActiveSequence();
    if (!q) return _err('QE 시퀀스 접근 실패');
    var tc = String(q.CTI.timecode);
    // [중요] QE exportFramePNG는 경로 끝에 '.png'를 자동으로 붙임 → 확장자 없는 base로 넘기고 실제 파일은 base+'.png'.
    var base = String(outPath).replace(/\.png$/i, '');
    var actual = base + '.png';
    try { var old = new File(actual); if (old.exists) old.remove(); } catch (er) {}
    q.exportFramePNG(tc, base);
    var f = new File(actual);
    if (!f.exists) { $.sleep(700); f = new File(actual); }
    if (!f.exists || f.length <= 0) return _err('QE 프레임 export 실패 — 시퀀스/재생헤드 확인');
    return _ok(_str(actual));
  } catch (e) {
    return _err('프레임 export 오류: ' + (e.message || e));
  }
}

// 프로젝트 전체 FCPXML 추출(멀티캠 싱크 내부용). 활성 시퀀스명 반환 → XML서 그 시퀀스 골라 처리.
function yanta_exportFcpXml(outputPath) {
  try {
    // OS 모양으로 넘긴다 — 슬래시로 부르면 윈도우에서 조용히 아무것도 안 만든다
    //   (같은 파일의 exportAsMediaDirect 가 실제로 그랬다).
    var native = _nativePath(outputPath);
    var ok = app.project.exportFinalCutProXML(native);
    // [돌려준 값만 믿지 않는다] 참을 돌려주고도 파일이 없는 경우가 있다. 이 XML을 읽는 건
    //   멀티캠 싱크인데, 없는 파일을 읽으러 가면 [싱크 실패]로만 보이고 원인이 여기라는 걸
    //   알 수 없다. 실제로 났는지 파일로 확인한다.
    var made = false;
    try { made = new File(native).exists; } catch (eF) { made = !!ok; }
    var nm = app.project.activeSequence ? app.project.activeSequence.name : '';
    return _ok('{"ok":' + (ok && made ? 'true' : 'false')
      + ',"seq":' + _str(nm)
      + ',"why":' + _str(ok && made ? '' : (!ok ? '프리미어가 내보내기를 거절했어요' : '내보냈다는데 파일이 없어요: ' + native)) + '}');
  } catch (e) { return _err(e); }
}

// 시퀀스 in-point (초). useInOut STT 시 타임스탬프 오프셋용.
function yanta_getInPoint() {
  var seq = _activeSeq();
  if (!seq) return _ok('0');
  try { var ip = seq.getInPoint(); return _ok(String(Number(ip))); }
  catch (e) { return _ok('0'); }
}

// Out 점(초) — 오디오 캐시 열쇠에 쓴다. In/Out 을 옮기면 뽑아 둔 오디오를 다시 써서는 안 된다.
function yanta_getOutPoint() {
  var seq = _activeSeq();
  if (!seq) return _ok('0');
  try { var op = seq.getOutPoint(); return _ok(String(Number(op))); }
  catch (e) { return _ok('0'); }
}

// 시퀀스 In/Out 점 (초) — AI가 "이 구간/IN-OUT" 인지하도록. hasInOut=실제 설정 여부.
function yanta_getInOut() {
  var seq = _activeSeq();
  if (!seq) return _ok('null');
  var inSec = 0, outSec = 0, hasInOut = false;
  try { inSec = Number(seq.getInPoint()); } catch (e) {}
  try { outSec = Number(seq.getOutPoint()); } catch (e) {}
  if (isNaN(inSec)) inSec = 0;
  if (isNaN(outSec)) outSec = 0;
  // out > in 이고 전체 길이와 다르면 실제 In/Out 설정된 것으로 간주
  var dur = 0; try { dur = Number(seq.end) / TPS; } catch (e) {}
  hasInOut = (outSec > inSec + 0.04) && !(inSec < 0.04 && Math.abs(outSec - dur) < 0.1);
  return _ok('{"inSec":' + _num(inSec) + ',"outSec":' + _num(outSec) + ',"hasInOut":' + (hasInOut ? 'true' : 'false') + '}');
}

// ── 마커 ──────────────────────────────────────────────────────────────
function yanta_addMarkers(jsonStr) {
  var arr;
  try { arr = _parse(jsonStr); } catch (e) { return _err('bad json'); }
  var seq = _activeSeq();
  if (!seq) return _err('no sequence');
  var n = 0;
  try {
    for (var i = 0; i < arr.length; i++) {
      var m = seq.markers.createMarker(arr[i].time);
      if (arr[i].name) m.name = arr[i].name;
      if (arr[i].comment) m.comments = arr[i].comment;
      n++;
    }
  } catch (e) { return _err(e); }
  return _ok(String(n));
}

// 클립 마커 — 타임라인이 이미 컷편집된 상태에서도 정확한 위치에 마커.
//   입력 time = 시퀀스 시간(STT는 시퀀스 믹스 기준). 각 비디오 클립의 시퀀스 span[start,end] 안에 들면
//   클립(projectItem) 소스 시간 = inPoint + (t - clipStart)에 클립 마커 → 클립 이동/추가컷에도 따라붙음.
//   매칭 클립 없으면(이미 컷되어 사라진 구간) 조용히 skip + skipped 카운트. 폴백: 시퀀스 마커.
function yanta_addClipMarkers(jsonStr) {
  var arr;
  try { arr = _parse(jsonStr); } catch (e) { return _err('bad json'); }
  var seq = _activeSeq();
  if (!seq) return _err('no sequence');
  var created = 0, skipped = 0;
  try {
    var nv = 0;
    try { nv = seq.videoTracks.numTracks; } catch (e0) { nv = 0; }
    for (var k = 0; k < arr.length; k++) {
      var t = Number(arr[k].time);
      var nm = arr[k].name ? String(arr[k].name) : '';
      var cm = arr[k].comment ? String(arr[k].comment) : '';
      var placed = false;
      for (var v = 0; v < nv && !placed; v++) {
        var track; try { track = seq.videoTracks[v]; } catch (e1) { continue; }
        var nc = 0; try { nc = track.clips.numItems; } catch (e2) { nc = 0; }
        for (var c = 0; c < nc; c++) {
          var clip; try { clip = track.clips[c]; } catch (e3) { continue; }
          var s, e; try { s = Number(clip.start.seconds); e = Number(clip.end.seconds); } catch (e4) { continue; }
          if (t >= s - 0.001 && t < e + 0.001) {
            var srcT = t; try { srcT = Number(clip.inPoint.seconds) + (t - s); } catch (e5) { srcT = t; }
            var ok = false;
            try {
              var pm = clip.projectItem.getMarkers();
              var m = pm.createMarker(srcT);
              if (nm) try { m.name = nm; } catch (e6) {}
              if (cm) try { m.comments = cm; } catch (e7) {}
              ok = true;
            } catch (e8) { ok = false; }
            if (!ok) { // 폴백 — 클립마커 미지원 시 시퀀스 마커(시퀀스 시간)
              try { var sm = seq.markers.createMarker(t); if (nm) sm.name = nm; if (cm) sm.comments = cm; ok = true; } catch (e9) {}
            }
            if (ok) { created++; placed = true; break; }
          }
        }
      }
      if (!placed) skipped++;
    }
  } catch (e) { return _err(e); }
  return _ok('{"created":' + created + ',"skipped":' + skipped + '}');
}

// ── 인/아웃 ───────────────────────────────────────────────────────────
function yanta_setInOut(inSec, outSec) {
  var seq = _activeSeq();
  if (!seq) return _err('no sequence');
  try { seq.setInPoint(inSec); seq.setOutPoint(outSec); return _ok('true'); }
  catch (e) { return _err(e); }
}

// ── 파일 임포트 ───────────────────────────────────────────────────────
function yanta_importFile(path) {
  try {
    var ok = app.project.importFiles([_nativePath(path)], true, app.project.getInsertionBin ? app.project.getInsertionBin() : app.project.rootItem, false);
    return _ok(ok ? 'true' : 'false');
  } catch (e) { return _err(e); }
}

// rootItem 재귀 탐색 — 경로 일치 projectItem 찾기 (임포트 결과 핸들 획득).
function _findPiByPath(item, path) {
  try {
    if (item.getMediaPath) { var p = item.getMediaPath(); if (p && p === path) return item; }
  } catch (e) {}
  try {
    if (item.children && item.children.numItems) {
      for (var i = 0; i < item.children.numItems; i++) {
        var f = _findPiByPath(item.children[i], path);
        if (f) return f;
      }
    }
  } catch (e) {}
  return null;
}

// 자막 SRT를 타임라인 캡션 트랙으로 직접 삽입 (프로젝트 패널에만 들어가던 문제 해결).
// 공식 API: Sequence.createCaptionTrack(srtProjectItem, startTicks) — 라이브 검증됨(26.x).
// SRT 타임스탬프 그대로 시퀀스 0 기준 배치 → 자막 시간 = 시퀀스 시간이면 오디오와 정확 일치.
function yanta_insertCaptionTrack(path) {
  var seq = _activeSeq();
  if (!seq) return _err('no sequence');
  if (typeof seq.createCaptionTrack !== 'function') return _err('이 Premiere 버전은 캡션트랙 API 미지원 — SRT를 프로젝트 패널서 타임라인으로 드래그하세요');
  try {
    // ① SRT 임포트 (이미 있으면 재사용)
    var pi = _findPiByPath(app.project.rootItem, path);
    if (!pi) {
      app.project.importFiles([_nativePath(path)], true, app.project.getInsertionBin ? app.project.getInsertionBin() : app.project.rootItem, false);
      pi = _findPiByPath(app.project.rootItem, path);
    }
    if (!pi) return _err('SRT 임포트 항목 못 찾음 (미디어 캐시 오류 가능 — 재시도)');
    // ② 캡션 트랙 생성(타임라인에 바로 올라감). startTicks="0" = 시퀀스 시작 기준.
    var t = seq.createCaptionTrack(pi, '0');
    return _ok(t ? 'true' : 'false');
  } catch (e) { return _err(e); }
}

// SRT → 캡션 트랙 생성 → "Upgrade Captions to Graphic" 메뉴 커맨드 자동 실행 → Essential Graphics 레이어로 변환.
//   Premiere가 텍스트→그래픽 직접 API 없어 [캡션 우회 + 내부 커맨드 자동화]. 버전별 메뉴명 다중 시도.
//   반환: 'graphic'=업그레이드 완료 / 'caption'=캡션트랙까지만(커맨드 못찾음 → 사용자 수동 업그레이드).
function yanta_captionsToGraphic(path) {
  var seq = _activeSeq();
  if (!seq) return _err('no sequence');
  if (typeof seq.createCaptionTrack !== 'function') return _err('이 Premiere 버전은 캡션트랙 API 미지원');
  try {
    var pi = _findPiByPath(app.project.rootItem, path);
    if (!pi) {
      app.project.importFiles([_nativePath(path)], true, app.project.getInsertionBin ? app.project.getInsertionBin() : app.project.rootItem, false);
      pi = _findPiByPath(app.project.rootItem, path);
    }
    if (!pi) return _err('SRT 임포트 실패 (미디어 캐시 오류 가능 — 재시도)');
    seq.createCaptionTrack(pi, '0');
    // 업그레이드 명령은 [캡션 클립이 선택돼 있을 때만] 활성화된다. 선택하지 않으면 메뉴가 회색이라
    //   명령을 불러도 아무 일이 일어나지 않는다.
    try {
      if (seq.captionTracks && seq.captionTracks.numTracks) {
        for (var ct = 0; ct < seq.captionTracks.numTracks; ct++) {
          var ctrack = seq.captionTracks[ct];
          if (!ctrack || !ctrack.clips) continue;
          for (var cc = 0; cc < ctrack.clips.numItems; cc++) {
            try { ctrack.clips[cc].setSelected(true, false); } catch (e0) {}
          }
        }
      }
    } catch (eSel) {}
    // [실측 2026-08-05 · Premiere 26.0] app.findMenuCommandId / app.executeCommand 가 이 버전에는
    //   아예 없다(typeof 'undefined'). sequence.captionTracks 도 노출되지 않는다. 즉 '캡션을 그래픽으로
    //   업그레이드'를 스크립트로 부를 방법이 없다. 캡션 트랙까지만 넣고 'caption'을 돌려주는 것이
    //   이 버전에서 할 수 있는 전부다 — 호출부는 그 사실을 사용자에게 그대로 알린다.
    if (typeof app.findMenuCommandId !== 'function') {
      return _ok('caption-only');
    }
    var names = ['캡션을 그래픽으로 업그레이드', '캡션을 그래픽으로 업그레이드...',
                 'Upgrade Captions to Graphic', 'Upgrade Caption to Graphic', 'Upgrade to Graphic', 'Captions to Graphic'];
    var done = false;
    for (var i = 0; i < names.length && !done; i++) {
      var cid = 0;
      try { cid = app.findMenuCommandId ? app.findMenuCommandId(names[i]) : 0; } catch (e) {}
      if (cid) {
        try {
          if (app.executeCommand) { app.executeCommand(cid); done = true; }
          else { app.enableQE(); if (qe && qe.executeMenuCommand) { qe.executeMenuCommand(cid); done = true; } }
        } catch (e2) {}
      }
    }
    return _ok(done ? 'graphic' : 'caption');
  } catch (e) { return _err(e); }
}

// 동적 오토믹싱 — trackMapping 기반 주발화자 결정(프론트 계산)을 받아 클립 enable/disable.
// 완전 동적: 트랙 번호 하드코딩 0. decisions의 trackIdx = 0-based 오디오 트랙(audioTracks[idx] 직결).
// (구 yanta_applyAutoMix 제거 — 매핑·세그먼트 기반 오토믹싱 폐기. 현재는 클립단위 Mic Bleed =
//  yanta_setClipsDisabled가 대체. 더 범용·정확하므로 중복 제거.)

// 네이티브 키프레임 더킹 — 지정 오디오 트랙(BGM)에 발화 구간 동안 볼륨을 부드럽게 낮춤(비파괴).
// 라이브 검증된 API: Volume 컴포넌트 → Level → setTimeVarying/addKey/setValueAtKey.
// ranges=[{start,end}] 발화(시퀀스초). duck=더킹비율(0.3=현재의 30%), fade=페이드(초).
// 정상레벨(getValue) 기준 상대 더킹 → 사용자 믹스 레벨 보존. 페이드아웃/인 키프레임으로 자연스럽게.
function yanta_duckAudioTrack(aTrack, rangesJson, duck, fade) {
  var seq = _activeSeq();
  if (!seq) return _err('no sequence');
  var ranges; try { ranges = _parse(rangesJson); } catch (e) { return _err('bad json'); }
  if (!ranges || !ranges.length) return _err('발화 구간 없음 (자막 먼저 인식)');
  if (aTrack == null || aTrack < 0 || !seq.audioTracks || aTrack >= seq.audioTracks.numTracks) return _err('오디오 트랙 번호 범위 밖');
  var d = (duck > 0 && duck < 1) ? duck : 0.3;
  var fd = (fade > 0) ? fade : 0.4;
  try {
    var track = seq.audioTracks[aTrack];
    if (!track.clips || !track.clips.numItems) return _err('A' + (aTrack + 1) + ' 트랙에 BGM 클립 없음');
    var applied = 0;
    for (var ci = 0; ci < track.clips.numItems; ci++) {
      var clip = track.clips[ci];
      var cs = clip.start.seconds, ce = clip.end.seconds;
      var lvl = null;
      if (!clip.components) continue;
      for (var k = 0; k < clip.components.numItems && !lvl; k++) {
        var comp = clip.components[k];
        if (!/볼륨|volume/i.test(comp.displayName || '') || !comp.properties) continue;
        for (var j = 0; j < comp.properties.numItems; j++) {
          if (/레벨|level/i.test(comp.properties[j].displayName || '')) { lvl = comp.properties[j]; break; }
        }
      }
      if (!lvl) continue;
      var normal; try { normal = lvl.getValue(); } catch (e) { normal = 1; }
      if (!(normal > 0)) normal = 1;
      var ducked = normal * d;
      try { lvl.setTimeVarying(true); } catch (e) {}
      try { lvl.addKey(cs); lvl.setValueAtKey(cs, normal, 0); } catch (e) {} // 시작 정상 앵커
      for (var r = 0; r < ranges.length; r++) {
        var s = Math.max(cs, Number(ranges[r].start)), e = Math.min(ce, Number(ranges[r].end));
        if (e - s <= 0.05) continue;
        var s0 = Math.max(cs, s - fd), e1 = Math.min(ce, e + fd);
        try {
          lvl.addKey(s0); lvl.setValueAtKey(s0, normal, 0);   // 페이드아웃 시작(정상)
          lvl.addKey(s); lvl.setValueAtKey(s, ducked, 0);     // 발화 시작(낮춤)
          lvl.addKey(e); lvl.setValueAtKey(e, ducked, 0);     // 발화 끝(유지)
          lvl.addKey(e1); lvl.setValueAtKey(e1, normal, 1);   // 페이드인 끝(복귀)
          applied++;
        } catch (e2) {}
      }
    }
    if (!applied) return _err('더킹 적용 구간 없음 (BGM 클립과 발화 구간이 겹치는지 확인)');
    return _ok('{"ducked":' + applied + '}');
  } catch (e) { return _err(e); }
}

// 오디오 파일을 임포트 후 지정 시각의 오디오 트랙에 덮어쓰기 (보컬/MR 적용용).
function yanta_overwriteAudioClip(path, atSec, aTrack) {
  var seq = _activeSeq();
  if (!seq) return _err('no sequence');
  try {
    app.project.importFiles([_nativePath(path)], true, app.project.getInsertionBin ? app.project.getInsertionBin() : app.project.rootItem, false);
    var pi = _findPiByPath(app.project.rootItem, path);
    if (!pi) return _err('임포트 항목 못 찾음');
    var at = _frameTicks(atSec || 0);
    var ai = (aTrack != null && aTrack >= 0) ? aTrack : 0;  // -1(트랙 못 찾음)이면 A1
    seq.overwriteClip(pi, at, 0, ai);  // 원본 클립의 트랙·시작 위치 그대로 바꿔치기(stem이 클립 길이만 추출됨)
    return _ok('true');
  } catch (e) { return _err(e); }
}

// 타임라인서 선택된 클립 — 오디오 처리(선택 클립만) 연동용. 없으면 null.
function yanta_getSelectedClip() {
  var seq = _activeSeq();
  if (!seq) return _err('no sequence');
  try {
    var sel = (typeof seq.getSelection === 'function') ? seq.getSelection() : null;
    if (!sel || !sel.length) return _ok('null');
    var it = sel[0];
    if (!it) return _ok('null');
    var path = ''; try { var pi = it.projectItem; if (pi && pi.getMediaPath) path = pi.getMediaPath(); } catch (e) {}
    // 시간 필드 — 오프라인/캐시 오류 클립은 inPoint 등이 undefined일 수 있음 → 개별 방어.
    var sIn = _safeSec(it, 'inPoint'), sOut = _safeSec(it, 'outPoint'), sSt = _safeSec(it, 'start'), sEn = _safeSec(it, 'end');
    var nm = ''; try { nm = it.name || ''; } catch (e) {}
    // 선택 클립이 속한 오디오 트랙 인덱스 — 보컬/MR '그 자리 그대로' 바꿔치기용. 비디오 선택이면 -1.
    var aTrack = -1;
    try {
      for (var ti = 0; ti < seq.audioTracks.numTracks; ti++) {
        var tr = seq.audioTracks[ti];
        for (var ci = 0; ci < tr.clips.numItems; ci++) {
          var cc = tr.clips[ci];
          if (cc === it || (cc.start && Math.abs(cc.start.seconds - sSt) < 0.001 && cc.name === nm)) { aTrack = ti; break; }
        }
        if (aTrack >= 0) break;
      }
    } catch (e) {}
    return _ok('{"path":' + _str(path) +
      ',"srcIn":' + _num(sIn) + ',"srcOut":' + _num(sOut) +
      ',"seqStart":' + _num(sSt) + ',"seqEnd":' + _num(sEn) +
      ',"aTrack":' + _num(aTrack) + ',"name":' + _str(nm) + '}');
  } catch (e) { return _err(e); }
}

// 프로젝트 파일(.prproj) 전체 경로 — 자막 기본 저장 위치(프로젝트 폴더) 산출용.
function yanta_getProjectPath() {
  try { return _ok(_str(app.project && app.project.path ? app.project.path : '')); }
  catch (e) { return _err(e); }
}

// 장면(=V1 클립) 목록 — 베스트컷용. 각 클립: 시퀀스 시작/끝, 소스 in/out, 미디어경로.
function yanta_getScenes() {
  var seq = _activeSeq();
  if (!seq) return _ok('[]');
  var out = [];
  try {
    var track = seq.videoTracks[0];
    for (var i = 0; i < track.clips.numItems; i++) {
      var c = track.clips[i];
      var path = '';
      try { var pi = c.projectItem; if (pi && pi.getMediaPath) path = pi.getMediaPath(); } catch (e) {}
      out.push('{"index":' + i +
        ',"seqStart":' + _num(c.start.seconds) + ',"seqEnd":' + _num(c.end.seconds) +
        ',"srcIn":' + _num(c.inPoint.seconds) + ',"srcOut":' + _num(c.outPoint.seconds) +
        ',"path":' + _str(path) + ',"name":' + _str(c.name) + '}');
    }
  } catch (e) { return _err(e); }
  return _ok('[' + out.join(',') + ']');
}

// 전 비디오 트랙 클립 (멀티캠·드론 — 카메라마다 다른 트랙). track 인덱스 포함.
// seqStart 겹치는 다른 트랙 클립 = 같은 순간 다른 앵글. 안 겹치면 별개 소재.
function _pushClips(tracks, kind, out, idxRef) {
  for (var t = 0; t < tracks.numTracks; t++) {
    var track = tracks[t];
    for (var i = 0; i < track.clips.numItems; i++) {
      var c = track.clips[i];
      var path = '';
      try { var pi = c.projectItem; if (pi && pi.getMediaPath) path = pi.getMediaPath(); } catch (e) {}
      out.push('{"index":' + idxRef.n + ',"ti":' + i + ',"track":' + t + ',"kind":' + _str(kind) +
        ',"seqStart":' + _num(c.start.seconds) + ',"seqEnd":' + _num(c.end.seconds) +
        ',"srcIn":' + _num(c.inPoint.seconds) + ',"srcOut":' + _num(c.outPoint.seconds) +
        ',"path":' + _str(path) + ',"name":' + _str(c.name) + '}');
      idxRef.n++;
    }
  }
}

// 전 트랙 클립 (비디오+오디오). kind=v/a, track=트랙인덱스, ti=트랙내인덱스.
// 멀티캠 싱크엔 오디오 트랙(별도 마이크)도 필수 → 둘 다 수집.
function yanta_getAllClips() {
  var seq = _activeSeq();
  if (!seq) return _ok('[]');
  var out = []; var idxRef = { n: 0 };
  try {
    _pushClips(seq.videoTracks, 'v', out, idxRef);
    _pushClips(seq.audioTracks, 'a', out, idxRef);
  } catch (e) { return _err(e); }
  return _ok('[' + out.join(',') + ']');
}

// 멀티캠 싱크 적용 — 클립을 deltaSec만큼 이동(trackItem.move). moves=[{track,kind,name,origStart,deltaSec}].
// ⚠️ trackItem.move()는 트랙 내 clips 배열을 재정렬 → ti 인덱스 즉시 무효(트랙당 다클립이면 엉뚱한 클립 이동).
//    해결: ti 쓰지 말고 매번 track.clips 재조회 후 'name(트랙내 유일) + origStart 근접'으로 대상 클립 식별.
// 우측 이동 시 충돌(overwrite) 줄이려 origStart 내림차순(가장 오른쪽 먼저).
function yanta_moveClips(jsonStr) {
  var moves;
  try { moves = _parse(jsonStr); } catch (e) { return _err('bad json'); }
  if (!moves || !moves.length) return _err('이동 없음');
  var seq = _activeSeq();
  if (!seq) return _err('no sequence');
  // 역순(origStart 내림차순) — 뒤 클립부터 이동해야 앞 클립 이동이 인덱스/겹침에 영향 안 줌.
  moves.sort(function (a, b) { return (b.origStart || 0) - (a.origStart || 0); });
  var done = 0, errs = [];
  var halfFrame = _frameDurSec() * 0.5 + 0.0005; // 검증 허용오차 = 반 프레임
  try {
    for (var k = 0; k < moves.length; k++) {
      var mv = moves[k];
      if (!mv || typeof mv.deltaSec !== 'number' || !isFinite(mv.deltaSec)) continue; // 깨진 값 방어
      if (Math.abs(mv.deltaSec) < 0.0005) { done++; continue; }
      var tracks = (mv.kind === 'a') ? seq.audioTracks : seq.videoTracks;
      if (!tracks || mv.track == null || mv.track < 0 || mv.track >= tracks.numTracks) continue;
      var track = tracks[mv.track];
      if (!track) continue;
      // 이름 일치 클립 중 origStart 가장 가까운 것(이동 후 재정렬돼도 이름으로 정확 식별).
      var best = -1, bestD = 1e9;
      for (var i = 0; i < track.clips.numItems; i++) {
        var cc = track.clips[i];
        if (mv.name && cc.name !== mv.name) continue;
        var d = Math.abs(cc.start.seconds - (mv.origStart != null ? mv.origStart : cc.start.seconds));
        if (d < bestD) { bestD = d; best = i; }
      }
      if (best < 0) { // 이름 매칭 실패 → origStart만으로 폴백
        for (var j = 0; j < track.clips.numItems; j++) {
          var d2 = Math.abs(track.clips[j].start.seconds - (mv.origStart || 0));
          if (d2 < bestD) { bestD = d2; best = j; }
        }
      }
      if (best < 0 || bestD >= 2.0) { errs.push((mv.name || ('트랙' + mv.track)) + ': 대상 클립 못 찾음'); continue; }
      // 목표 위치를 프레임 격자에 스냅 → 1프레임도 안 밀림. 이동량 = 스냅목표 − 현재.
      var clip = track.clips[best];
      var curSec = clip.start.seconds;
      var targetSec = _snapSec(curSec + mv.deltaSec);
      if (targetSec < 0) targetSec = 0;
      var snapDelta = targetSec - curSec;
      try { clip.move(Number(snapDelta)); } catch (e) { errs.push((mv.name || '') + ': 이동 실패 ' + e); continue; }
      // 무결성 검사 — 이동 후 이름 클립이 목표 프레임(±반프레임)에 실제로 있는지 재확인.
      var okMove = false;
      for (var v = 0; v < track.clips.numItems; v++) {
        var vc = track.clips[v];
        if (mv.name && vc.name !== mv.name) continue;
        if (Math.abs(vc.start.seconds - targetSec) <= halfFrame) { okMove = true; break; }
      }
      if (okMove) done++;
      else errs.push((mv.name || ('트랙' + mv.track)) + ': 목표 ' + targetSec.toFixed(3) + 's 미도달(잠긴 트랙·겹침 의심)');
    }
    // 검증 결과 함께 반환 — 호출부가 에러를 사용자에게 즉시 보고.
    return _ok('{"moved":' + done + ',"errors":[' + (function () { var a = []; for (var e2 = 0; e2 < errs.length; e2++) a.push(_str(errs[e2])); return a.join(','); })() + ']}');
  } catch (e) { return _err(e); }
}

// 세그먼트 목록을 지정 순서로 새 시퀀스 조립 (멀티소스/서브레인지, A/V 동기, 순서 보존).
// segs = [{path, srcIn, srcOut}] (원하는 순서). 단일 긴 영상 장면컷 + 멀티 테이크 둘 다 커버.
function yanta_buildFromSegments(jsonStr, name) {
  var segs;
  try { segs = _parse(jsonStr); } catch (e) { return _err('bad json'); }
  if (!segs || !segs.length) return _err('세그먼트 없음');
  var seq = _activeSeq();
  if (!seq) return _err('no sequence');
  try {
    var byPath = {};
    var track = seq.videoTracks[0];
    for (var i = 0; i < track.clips.numItems; i++) {
      var c = track.clips[i]; var pi = c.projectItem;
      if (pi && pi.getMediaPath) { var p = pi.getMediaPath(); if (p && !byPath[p]) byPath[p] = pi; }
    }
    // overwriteClip로 소스 in/out 범위를 새 시퀀스에 순서대로 배치 (서브클립/렌더 없음 = 용량 증가 X).
    // 빈 시퀀스 먼저 만들고, 각 세그먼트를 running 위치에 overwrite → 공유 pi 변경 충돌 없음.
    var ns = null, running = 0, used = 0;
    for (var k = 0; k < segs.length; k++) {
      var sg = segs[k]; var src = byPath[sg.path];
      if (!src) continue;
      var inS = _snapSec(sg.srcIn), outS = _snapSec(sg.srcOut); // 소스 in/out 프레임 스냅
      if (outS - inS < _frameDurSec()) continue;                 // 1프레임 미만 무시
      src.setInPoint(inS, 4);
      src.setOutPoint(outS, 4);
      if (!ns) {
        ns = app.project.createNewSequenceFromClips(name || (seq.name + '_대본컷'), [src]);
        if (!ns) return _err('새 시퀀스 생성 실패');
      } else {
        ns.overwriteClip(src, _frameTicks(running), 0, 0);
      }
      running += (outS - inS);
      used++;
    }
    if (!ns) return _err('유효 세그먼트 없음');
    // 무결성 검사 — 배치된 클립 수가 사용한 세그먼트 수와 일치하는지.
    var built2 = -1; try { built2 = ns.videoTracks[0].clips.numItems; } catch (e4) {}
    var warn2 = (built2 >= 0 && built2 !== used) ? (',"warning":' + _str('클립 수 불일치: 기대 ' + used + ', 실제 ' + built2)) : '';
    return _ok('{"name":' + _str(ns.name) + ',"duration":' + _num(running) + ',"scenes":' + used + ',"built":' + _num(built2) + warn2 + '}');
  } catch (e) { return _err(e); }
}

// 선택 장면을 지정 순서로 새 시퀀스 조립 (멀티 소스, A/V 동기). order = V1 클립 인덱스 배열.
function yanta_buildSceneSequence(jsonStr, name) {
  var order;
  try { order = _parse(jsonStr); } catch (e) { return _err('bad json'); }
  if (!order || !order.length) return _err('선택 장면 없음');
  var seq = _activeSeq();
  if (!seq) return _err('no sequence');
  try {
    var track = seq.videoTracks[0];
    var clips = [];
    for (var k = 0; k < track.clips.numItems; k++) clips.push(track.clips[k]);
    var ns = null, running = 0;
    for (var i = 0; i < order.length; i++) {
      var c = clips[order[i]];
      if (!c) continue;
      var pi = c.projectItem;
      if (!pi) continue;
      var inS = Number(c.inPoint.seconds), outS = Number(c.outPoint.seconds);
      pi.setInPoint(inS, 4);
      pi.setOutPoint(outS, 4);
      if (!ns) {
        ns = app.project.createNewSequenceFromClips(name || (seq.name + '_베스트컷'), [pi]);
        if (!ns) return _err('새 시퀀스 생성 실패');
      } else {
        ns.insertClip(pi, _frameTicks(running), 0, 0);
      }
      running += (outS - inS);
    }
    if (!ns) return _err('유효 장면 없음');
    return _ok('{"name":' + _str(ns.name) + ',"duration":' + _num(running) + ',"scenes":' + order.length + '}');
  } catch (e) { return _err(e); }
}

// 유지구간으로 새 시퀀스 재구성 (A/V 완벽 동기). razor/ripple desync 대체 + 비파괴(원본 유지).
// keep = [{start,end},...] 초. 원본 단일 미디어에서 각 구간을 in/out으로 잘라 순서대로 insert.
// (검증: setInPoint/createNewSequenceFromClips가 in/out 반영, insertClip이 A/V 함께 삽입)
function yanta_buildKeepSequence(jsonStr, name) {
  var keep;
  try { keep = _parse(jsonStr); } catch (e) { return _err('bad json'); }
  if (!keep || !keep.length) return _err('유지구간 없음');
  var seq = _activeSeq();
  if (!seq) return _err('no sequence');
  try {
    if (!seq.videoTracks || seq.videoTracks.numTracks < 1) return _err('비디오 트랙 없음 — 영상 클립이 있는 시퀀스에서 실행하세요');
    var v0 = seq.videoTracks[0];
    if (!v0 || !v0.clips || v0.clips.numItems < 1) return _err('V1 트랙에 클립 없음 — 컷할 영상이 없습니다');
    var pi = v0.clips[0].projectItem;
    if (!pi) return _err('소스 미디어 못 찾음 (미디어 오프라인/캐시 오류 가능 — 재연결 후 재시도)');
    // 실제 콘텐츠 한계 = V1 마지막 클립의 end. 이를 넘는 구간은 미디어 없음(빗금 phantom) → 클램프/제외.
    var maxEnd = v0.clips.numItems ? v0.clips[v0.clips.numItems - 1].end.seconds : 0;
    var fdur = _frameDurSec();
    var clean = [];
    for (var j = 0; j < keep.length; j++) {
      var s = _snapSec(keep[j].start), e = _snapSec(keep[j].end); // 프레임 격자 스냅 = 1프레임도 안 밀림
      if (maxEnd > 0 && e > maxEnd) e = _snapSec(maxEnd);          // 끝 클램프
      if (e - s >= fdur && s < maxEnd + 0.001) clean.push({ start: s, end: e }); // 1프레임↑ & 콘텐츠 내
    }
    if (!clean.length) return _err('유효 유지구간 없음(미디어 범위 밖)');
    clean.sort(function (a, b) { return a.start - b.start; });
    pi.setInPoint(clean[0].start, 4);
    pi.setOutPoint(clean[0].end, 4);
    var seqName = name || (seq.name + '_편집본');
    var ns = app.project.createNewSequenceFromClips(seqName, [pi]);
    if (!ns) return _err('새 시퀀스 생성 실패');
    var running = clean[0].end - clean[0].start;
    for (var i = 1; i < clean.length; i++) {
      pi.setInPoint(clean[i].start, 4);
      pi.setOutPoint(clean[i].end, 4);
      ns.insertClip(pi, _frameTicks(running), 0, 0);
      running += (clean[i].end - clean[i].start);
    }
    // 무결성 검사 — 새 시퀀스 V1 클립 수가 유지구간 수와 일치하는지(빈클립 복제/누락 감지).
    var built = -1;
    try { built = ns.videoTracks[0].clips.numItems; } catch (e3) {}
    var warn = (built >= 0 && built !== clean.length) ? (',"warning":' + _str('클립 수 불일치: 기대 ' + clean.length + ', 실제 ' + built + ' (일부 구간 누락/중복 가능)')) : '';
    return _ok('{"name":' + _str(ns.name) + ',"duration":' + _num(running) + ',"segments":' + clean.length + ',"built":' + _num(built) + warn + '}');
  } catch (e) { return _err(e); }
}

// 활성 시퀀스 복제 (파괴적 razor/ripple 편집 전 백업).
// clone()은 복사본을 새 활성으로 만듦 → 복사본 이름을 origName+label 로 바꾸고
// 그 위에서 편집 → 원본은 손 안 댄 채 보존(razor는 표준 undo 안 되므로 진짜 비파괴).
// label 없으면 원본만 복제(이름 자동). 반환: 활성(편집할) 시퀀스 이름.
function yanta_cloneActiveSequence(label) {
  var seq = _activeSeq();
  if (!seq) return _err('no sequence');
  try {
    if (typeof seq.clone !== 'function') return _err('clone API 없음 (이 버전 미지원)');
    var origName = seq.name;
    var origId = String(seq.sequenceID);
    seq.clone();
    var act = app.project.activeSequence;
    // 복사본이 활성이 됐으면(=원본과 다른 ID) 이름 지정.
    // label = JS 네이밍 포맷터가 만든 [완성된 클린 이름]. 누적 방지 위해 origName에 이어붙이지 않고 그대로 사용.
    if (act && String(act.sequenceID) !== origId && label) {
      try { act.name = label; } catch (e) {}
    }
    return _ok(_str(app.project.activeSequence ? app.project.activeSequence.name : origName));
  } catch (e) { return _err(e); }
}

// 프로젝트 시퀀스 목록 (정리/선택용). [{index,name,active}]
function yanta_listSequences() {
  try {
    var p = app.project;
    var active = p.activeSequence;
    var out = [];
    for (var i = 0; i < p.sequences.numSequences; i++) {
      var s = p.sequences[i];
      var isActive = (active && String(s.sequenceID) === String(active.sequenceID)) ? 'true' : 'false';
      out.push('{"index":' + i + ',"name":' + _str(s.name) + ',"active":' + isActive + '}');
    }
    return _ok('[' + out.join(',') + ']');
  } catch (e) { return _err(e); }
}

// 이름 정확일치 시퀀스 활성화 (정리 시 원본 복귀용).
function yanta_activateSequenceByName(name) {
  try {
    var p = app.project;
    for (var i = 0; i < p.sequences.numSequences; i++) {
      var s = p.sequences[i];
      if (s.name === name) {
        if (typeof p.openSequence === 'function') { p.openSequence(s.sequenceID); return _ok('true'); }
        p.activeSequence = s; return _ok('true');
      }
    }
    return _err('시퀀스 없음: ' + name);
  } catch (e) { return _err(e); }
}

// 이름 정확일치 시퀀스 삭제 (테스트 클론 정리용). 삭제 개수 반환.
// ⚠️ 정확 일치만 — "ok 복사"는 "ok"와 매칭 안 됨. 역순 순회(인덱스 변동 대비).
function yanta_deleteSequenceByName(name) {
  try {
    var p = app.project;
    if (typeof p.deleteSequence !== 'function') return _err('deleteSequence API 없음');
    var deleted = 0;
    for (var i = p.sequences.numSequences - 1; i >= 0; i--) {
      var s = p.sequences[i];
      if (s.name === name) { p.deleteSequence(s); deleted++; }
    }
    return _ok(String(deleted));
  } catch (e) { return _err(e); }
}

// 메뉴 명령 실행 (예: Scene Edit Detection). id는 버전별 상이.
function yanta_executeCommand(id) {
  try { app.enableQE(); qe.executeMenuCommand ? qe.executeMenuCommand(id) : app.sourceMonitor; return _ok('true'); }
  catch (e) { return _err(e); }
}

// ── MOGRT 모션 자막 ───────────────────────────────────────────────────
// Premiere Essential Graphics 템플릿(.mogrt)을 자막 시간에 삽입 + 텍스트 채움.
// 화려한 애니메이션 자막(로어서드/카라오케)을 네이티브로 — Remotion 불필요.

// 설치된 .mogrt 템플릿 스캔 (EGP 패널이 읽는 동일 경로 + Yanta 폴더).
// [윈도우] 예전에는 '~/Library/Application Support/...' 만 훑었다. 맥 전용 경로라
//   윈도우에서는 템플릿 목록이 통째로 비었다(자막 템플릿 기능 전체가 죽음).
//   Folder.userData 는 맥에서 ~/Library/Application Support, 윈도우에서 %APPDATA% 를 가리킨다
//   — 두 OS를 한 줄로 덮는 유일한 방법이라 이걸 기준으로 삼는다.
function _mogrtRoots() {
  var out = [];
  var add = function (p) { if (p) out.push(String(p)); };
  try {
    var ud = Folder.userData ? String(Folder.userData.absoluteURI) : '';
    if (ud) {
      add(ud + '/Adobe/Common/Motion Graphics Templates');
      add(ud + '/Yanta/mogrt');
    }
  } catch (e1) {}
  try {
    var docs = Folder.myDocuments ? String(Folder.myDocuments.absoluteURI) : '';
    // 버전별 하위 폴더(.../Premiere Pro/26.0/...)가 있어 상위를 준다 — _scanMogrt가 재귀한다.
    if (docs) add(docs + '/Adobe/Premiere Pro');
  } catch (e2) {}
  add('/Library/Application Support/Adobe/Common/Motion Graphics Templates');   // macOS 공용
  try {
    var pf = $.getenv('ProgramFiles');                                          // Windows 공용
    if (pf) add(String(pf).replace(/\\/g, '/') + '/Adobe/Common/Motion Graphics Templates');
  } catch (e3) {}
  return out;
}

function yanta_listMogrtTemplates() {
  var roots = _mogrtRoots();
  var out = [], seen = {}, byName = {};
  try {
    for (var r = 0; r < roots.length; r++) { _scanMogrt(new Folder(roots[r]), out, seen, byName, 0, ''); }
  } catch (e) { return _err(e); }
  return _ok('[' + out.join(',') + ']');
}

// 파일 이름·폴더 이름으로 갈래를 정한다. 161개를 한 줄로 늘어놓으면 고를 수가 없다.
// macOS는 파일 이름을 자모가 분해된 형태(NFD)로 저장한다. 그래서 '비명'을 그대로 비교하면
//   같은 글자인데도 안 맞는다 — 분류가 통째로 실패하던 원인이 이것이다(실측: 161개 중 157개가 기타).
//   ExtendScript에는 normalize가 없어, 한글 자모(U+1100~U+11FF)를 완성형으로 직접 합친다.
function _nfc(str) {
  var s = String(str || ''), out = '', i = 0;
  var CHO = 0x1100, JUNG = 0x1161, JONG = 0x11A7;
  while (i < s.length) {
    var c = s.charCodeAt(i);
    if (c >= CHO && c <= 0x1112 && i + 1 < s.length) {
      var v = s.charCodeAt(i + 1);
      if (v >= JUNG && v <= 0x1175) {
        var t = 0, len = 2;
        if (i + 2 < s.length) {
          var tc = s.charCodeAt(i + 2);
          if (tc > JONG && tc <= 0x11C2) { t = tc - JONG; len = 3; }
        }
        out += String.fromCharCode(0xAC00 + ((c - CHO) * 21 + (v - JUNG)) * 28 + t);
        i += len;
        continue;
      }
    }
    out += s.charAt(i);
    i++;
  }
  return out;
}

function _mogrtCategory(name, folder) {
  var t = _nfc(name + ' ' + folder).toLowerCase();
  // 실제 설치된 이름들을 보고 정한 규칙 — '강원 튼튼 분노', '귀여운 강조 - 외곽선 메이플',
  //   '무서운 상황체', '진중체', '설명 자막' 처럼 이름에 쓰임새가 그대로 적혀 있다.
  //   순서가 중요하다: '귀여운 강조'는 강조보다 귀여움으로 보는 게 맞다.
  if (/귀여|말랑|쿠키런|메이플|뽀짝|둥글|아기|하트|튀어오르|통통/.test(t)) return '귀여움';
  if (/분노|화난|빡|무서운|비명|슬픈|눈물|놀란|당황|뻘쭘|짜증|몽롱|우울|따스|설레|감정/.test(t)) return '감정';
  if (/강조|포인트|두 단어|하이라이트|highlight/.test(t)) return '포인트';
  if (/진중|다큐|정갈|심플|깔끔|미니멀|기본|clean|simple|minimal/.test(t)) return '정갈';
  if (/타이틀|제목|인트로|title|intro|오프닝/.test(t)) return '타이틀';
  if (/이름표|명찰|lower ?third|로어/.test(t)) return '이름표';
  if (/자막|캡션|caption|subtitle|대사|말자막|체$|체[v0-9]/.test(t)) return '말자막';
  return '기타';
}

// 어도비가 기본 제공하는 템플릿 이름 — 폴더를 옮겨 두는 경우가 있어 이름으로도 거른다.
function _isAdobeName(name) {
  var n = String(name || '');
  if (/^AdobeStock_/i.test(n)) return true;
  // 'Basic Title', 'Simple Web Caption', 'Sports Lower Third Center' 같은 영문 조합.
  return /^(Basic|Simple|Classic|Film|Angled|Modern|Bold|Sports|Gaming|Twitch|YouTube)\s+(Title|Caption|Lower ?Third|Intro|Slate|Overlay|Chat)/i.test(n);
}

function _isAdobeStock(folder) {
  return /^(Captions and Subtitles|Titles|Lower Thirds|Slates|Credits|Graphic Overlays|Social Media|\[AE\])/i
    .test(String(folder || ''));
}

function _scanMogrt(folder, out, seen, byName, depth, parentName) {
  if (!folder || !folder.exists || depth > 3) return;
  var items;
  try { items = folder.getFiles(); } catch (e) { return; }
  var fname = '';
  try { fname = decodeURIComponent(folder.name); } catch (e) { fname = folder.name || ''; }
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    if (it instanceof Folder) { _scanMogrt(it, out, seen, byName, depth + 1, fname); continue; }
    if (!/\.mogrt$/i.test(it.name) || seen[it.fsName]) continue;
    seen[it.fsName] = 1;
    var nm = it.name;
    try { nm = decodeURIComponent(it.name); } catch (e) {}
    nm = _nfc(nm.replace(/\.mogrt$/i, ''));
    // 같은 이름이 여러 폴더에 있으면 하나만 남긴다 — 목록에 같은 게 두 번 보이면 고르기 어렵다.
    var key = nm.toLowerCase().replace(/[\s_-]+/g, '');
    if (byName[key]) continue;
    byName[key] = 1;
    // [버그였던 곳] fname = 이 파일이 들어 있는 폴더. parentName은 그 위 폴더라 판정에 쓰면 안 된다.
    if (_isAdobeStock(fname) || _isAdobeName(nm)) continue;
    var cat = _mogrtCategory(nm, fname);
    out.push('{"name":' + _str(nm) + ',"path":' + _str(it.fsName)
      + ',"category":' + _str(cat) + ',"folder":' + _str(parentName || fname) + '}');
  }
}

// 트랙에서 start(초)가 sec에 근접한 클립 찾기 (importMGT 반환 불안정 대비).
function _findClipAt(track, sec) {
  if (!track) return null;
  for (var i = 0; i < track.clips.numItems; i++) {
    var c = track.clips[i];
    if (Math.abs(c.start.seconds - sec) < 0.05) return c;
  }
  return null;
}

// MOGRT 클립 end(초)로 트림 — 자막 길이에 맞춤.
function _setClipEnd(clip, endSec) {
  try { var t = new Time(); t.ticks = _frameTicks(endSec); clip.end = t; return true; }
  catch (e) { return false; }
}

// MOGRT 텍스트 파라미터에 text 주입. 스타일(폰트/색) 보존 — 값 JSON에서 텍스트만 치환.
// 텍스트 파라미터 식별: 현재값 JSON에 textEditValue/mText/"text" 포함. 첫 매칭만.
// MOGRT/그래픽 클립의 텍스트 읽기 — 채우기(_setMogrtText)의 역. textEditValue/mTextValue 파싱.
function _getMogrtText(clip) {
  try {
    if (!clip || typeof clip.getMGTComponent !== 'function') return '';
    var comp = clip.getMGTComponent();
    if (!comp || !comp.properties) return '';
    var props = comp.properties;
    for (var i = 0; i < props.numItems; i++) {
      var cur = '';
      try { cur = String(props[i].getValue()); } catch (e) { continue; }
      var m = cur.match(/"(?:textEditValue|mTextValue)"\s*:\s*"((?:\\.|[^"\\])*)"/);
      if (m && m[1]) return m[1].replace(/\\n/g, ' ').replace(/\\"/g, '"').replace(/\\\\/g, '\\').replace(/\s+/g, ' ').trim();
    }
  } catch (e) {}
  return '';
}

// 현재 시퀀스의 자막/텍스트(MOGRT·그래픽) 클립을 순회해 STT JSON으로 추출.
// 타임라인 텍스트를 플러그인 내부 데이터로 — 대본 편집·AI 요약 원천. 시작 정렬 정렬.
function yanta_importTimelineCaptions() {
  var seq = _activeSeq();
  if (!seq) return _err('no sequence');
  try {
    var rows = [];
    for (var t = 0; t < seq.videoTracks.numTracks; t++) {
      var track = seq.videoTracks[t];
      for (var c = 0; c < track.clips.numItems; c++) {
        var clip = track.clips[c];
        var txt = _getMogrtText(clip);
        if (!txt || !txt.replace(/\s/g, '').length) continue;
        var st = clip.start, en = clip.end;
        rows.push({ s: _num(st.seconds), e: _num(en.seconds), st: String(st.ticks), et: String(en.ticks), tx: txt });
      }
    }
    rows.sort(function (a, b) { return a.s - b.s; });
    var out = [];
    for (var i = 0; i < rows.length; i++) {
      out.push('{"text":' + _str(rows[i].tx) + ',"start":' + _num(rows[i].s) + ',"end":' + _num(rows[i].e) +
        ',"startTick":' + _str(rows[i].st) + ',"endTick":' + _str(rows[i].et) + '}');
    }
    return _ok('[' + out.join(',') + ']');
  } catch (e) { return _err(e); }
}

function _setMogrtText(clip, text) {
  try {
    if (!clip || typeof clip.getMGTComponent !== 'function') return false;
    var comp = clip.getMGTComponent();
    if (!comp || !comp.properties) return false;
    var props = comp.properties, esc = String(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    for (var i = 0; i < props.numItems; i++) {
      var p = props[i], cur = '';
      try { cur = String(p.getValue()); } catch (e) { continue; }
      if (cur.indexOf('textEditValue') >= 0) {
        // 스타일 보존: "textEditValue":"..." 값만 교체
        var nv = cur.replace(/("textEditValue"\s*:\s*")(?:\\.|[^"\\])*(")/, '$1' + esc + '$2');
        try { p.setValue(nv, 1); return true; } catch (e) {}
      } else if (cur.indexOf('mTextValue') >= 0) {
        var nv2 = cur.replace(/("mTextValue"\s*:\s*")(?:\\.|[^"\\])*(")/, '$1' + esc + '$2');
        try { p.setValue(nv2, 1); return true; } catch (e) {}
      }
    }
    // 폴백: textEditValue JSON 통째로 (스타일 기본값)
    for (var j = 0; j < props.numItems; j++) {
      try { props[j].setValue('{"textEditValue":"' + esc + '"}', 1); return true; } catch (e) {}
    }
    return false;
  } catch (e) { return false; }
}

// 단일 MOGRT 삽입 (인트로 타이틀/로어서드). o={ path, atSec, durSec?, text?, vTrack? }
function yanta_insertMogrt(jsonStr) {
  var o; try { o = _parse(jsonStr); } catch (e) { return _err('bad json'); }
  if (!o || !o.path) return _err('경로 없음');
  var seq = _activeSeq(); if (!seq) return _err('no sequence');
  try {
    if (typeof seq.importMGT !== 'function') return _err('importMGT API 없음 (이 버전 미지원)');
    var vTrack = (o.vTrack != null) ? o.vTrack : (seq.videoTracks.numTracks - 1);
    var at = o.atSec || 0, ticks = _frameTicks(at);
    var track = seq.videoTracks[vTrack];
    // 원래 있던 클립을 기억해 두고 [새로 생긴 것]만 고른다 — 같은 자리에 다른 그래픽이 있으면
    //   시간만 보고 찾다가 남의 클립을 건드린다(실측 사고).
    var seen = _snapClips(track);
    seq.importMGT(_nativePath(o.path), ticks, vTrack, -1);
    var clip = _findNewClip(track, seen, at);
    if (!clip) return _err('MOGRT 삽입 실패 (경로/트랙 확인)');
    var textRes = o.text ? _setMogrtText(clip, o.text) : 'skip';
    if (o.durSec && o.durSec > 0) _setClipEnd(clip, at + o.durSec);
    return _ok(_str(textRes));
  } catch (e) { return _err(e); }
}

// MOGRT 텍스트 색상 — textEditValue JSON 안의 fillColor를 hex→RGB(0..1)로 교체(스타일 보존).
// EGP 포맷마다 색상 키가 다를 수 있어 best-effort. hex='#RRGGBB'.
function _setMogrtColor(clip, hex) {
  try {
    if (!clip || typeof clip.getMGTComponent !== 'function' || !hex) return false;
    var h = String(hex).replace('#', '');
    var r = parseInt(h.substring(0, 2), 16) / 255, g = parseInt(h.substring(2, 4), 16) / 255, b = parseInt(h.substring(4, 6), 16) / 255;
    var rgb = '[' + r + ',' + g + ',' + b + ',1]';
    var comp = clip.getMGTComponent(); if (!comp || !comp.properties) return false;
    var props = comp.properties;
    for (var i = 0; i < props.numItems; i++) {
      var p = props[i], cur = '';
      try { cur = String(p.getValue()); } catch (e) { continue; }
      if (cur.indexOf('fillColor') >= 0) {
        var nv = cur.replace(/("fillColor"\s*:\s*)\[[^\]]*\]/, '$1' + rgb);
        try { p.setValue(nv, 1); return true; } catch (e2) {}
      }
    }
    return false;
  } catch (e) { return false; }
}

// 화자 분리형 동적 자막 — 화자별로 지정된 V트랙 + 고유 색상으로 MOGRT 자막 삽입.
// o={ path, cues:[{text,start,end,vTrack,color}] }. vTrack=화자별 동적 할당(V2,V3..), color='#RRGGBB'.
// 완전 동적: cue마다 자기 vTrack/색상 따름. createCaptionTrack/순수텍스트 미사용 — Mogrt만.
function yanta_insertSpeakerCaptions(jsonStr) {
  var o; try { o = _parse(jsonStr); } catch (e) { return _err('bad json'); }
  if (!o || !o.path) return _err('mogrt 경로 없음');
  var seq = _activeSeq(); if (!seq) return _err('no sequence');
  var cues = o.cues || [];
  if (!cues.length) return _err('자막 cue 없음');
  if (typeof seq.importMGT !== 'function') return _err('importMGT API 없음 (이 버전 미지원)');
  var mf = new File(o.path); if (!mf.exists) return _err('mogrt 파일 없음: ' + o.path);
  var done = 0, failed = 0, nV = seq.videoTracks.numTracks;
  try {
    for (var i = 0; i < cues.length; i++) {
      var c = cues[i], at = c.start, dur = c.end - c.start;
      var vT = (c.vTrack != null) ? c.vTrack : (nV - 1);
      if (dur <= 0.02 || vT < 0 || vT >= nV) { failed++; continue; }
      var ticks = _frameTicks(at), clip = null;
      try { clip = seq.importMGT(_nativePath(o.path), ticks, vT, -1); } catch (e) { failed++; continue; }
      if (!clip || typeof clip.getMGTComponent !== 'function') clip = _findClipAt(seq.videoTracks[vT], at);
      if (clip) {
        if (c.text) _setMogrtText(clip, c.text);
        if (c.color) _setMogrtColor(clip, c.color);
        _setClipEnd(clip, c.end);              // endTick 정확 트림
        done++;
      } else failed++;
    }
    return _ok('{"inserted":' + done + ',"failed":' + failed + '}');
  } catch (e) { return _err(e); }
}

// 자막 전체를 MOGRT 모션 자막으로 삽입 (각 자막 = 1 MOGRT, 텍스트·길이 자동).
// o={ path, vTrack?, segments:[{text,start,end}] }. 기본 vTrack = 최상단(영상 위 오버레이).
function yanta_insertMogrtCaptions(jsonStr) {
  var o; try { o = _parse(jsonStr); } catch (e) { return _err('bad json'); }
  if (!o || !o.path) return _err('경로 없음');
  var seq = _activeSeq(); if (!seq) return _err('no sequence');
  var segs = o.segments || [];
  if (!segs.length) return _err('자막 없음');
  if (typeof seq.importMGT !== 'function') return _err('importMGT API 없음');
  var vTrack = (o.vTrack != null) ? o.vTrack : (seq.videoTracks.numTracks - 1);
  var done = 0, failed = 0;
  try {
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i], at = s.start, dur = s.end - s.start;
      if (dur <= 0.02) { failed++; continue; }
      var ticks = _frameTicks(at), clip = null;
      try { clip = seq.importMGT(_nativePath(o.path), ticks, vTrack, -1); } catch (e) { failed++; continue; }
      if (!clip || typeof clip.getMGTComponent !== 'function') clip = _findClipAt(seq.videoTracks[vTrack], at);
      if (clip) { if (s.text) _setMogrtText(clip, s.text); _setClipEnd(clip, s.end); done++; }
      else failed++;
    }
    return _ok('{"inserted":' + done + ',"failed":' + failed + '}');
  } catch (e) { return _err(e); }
}
// ── 프로젝트 패널 정리(bin 분류) ─────────────────────────────────────
// 복구본: host.jsx 스냅샷이 정리 기능 추가 시점보다 옛 버전이라 이 블록이 통째로 빠져 있었음
//   (패널이 yanta_getProjectItems 등을 호출 → 정의 없음 → 빈 결과 → "정리할 항목 없음").
var YANTA_HOST_VER = 'v7-paged';

function _collectItems(item, parentName, out) {
  try {
    if (item.children && item.children.numItems) {
      for (var i = 0; i < item.children.numItems; i++) {
        var c = item.children[i];
        var nodeId = '', name = '', type = 0, media = '';
        try { nodeId = String(c.nodeId); } catch (e) {}
        try { name = String(c.name); } catch (e) {}
        try { type = Number(c.type) || 0; } catch (e) {}
        try { if (c.getMediaPath) { var mp = c.getMediaPath(); if (mp) media = String(mp); } } catch (e) {}
        out.push('{"nodeId":' + _str(nodeId) + ',"name":' + _str(name)
          + ',"type":' + type + ',"mediaPath":' + _str(media)
          + ',"parentName":' + _str(parentName) + '}');
        // BIN이면 하위로 재귀(소속 이름 = 이 bin 이름).
        if (type === 2) _collectItems(c, name, out);
      }
    }
  } catch (e) {}
}

function _findChildBin(parent, name) {
  try {
    if (parent.children && parent.children.numItems) {
      for (var i = 0; i < parent.children.numItems; i++) {
        var c = parent.children[i];
        try { if (Number(c.type) === 2 && String(c.name) === name) return c; } catch (e) {}
      }
    }
  } catch (e) {}
  return null;
}

function _ensureBinPath(root, path) {
  var segs = String(path).split('/');
  var cur = root;
  for (var i = 0; i < segs.length; i++) {
    var name = segs[i];
    if (!name) continue;
    var child = _findChildBin(cur, name);
    if (!child) { try { cur.createBin(name); } catch (e) {} child = _findChildBin(cur, name); }
    if (!child) return null;
    cur = child;
  }
  return cur;
}

function _findPiByNodeId(item, id) {
  try { if (String(item.nodeId) === id) return item; } catch (e) {}
  try {
    if (item.children && item.children.numItems) {
      for (var i = 0; i < item.children.numItems; i++) {
        var f = _findPiByNodeId(item.children[i], id);
        if (f) return f;
      }
    }
  } catch (e) {}
  return null;
}

function _seqMediaPaths(seq) {
  var seen = {}; var out = [];
  function scan(coll) {
    try {
      for (var t = 0; t < coll.numTracks; t++) {
        var track = coll[t];
        for (var c = 0; c < track.clips.numItems; c++) {
          try {
            var pi = track.clips[c].projectItem;
            if (pi && pi.getMediaPath) {
              var p = pi.getMediaPath();
              if (p && !seen[p]) { seen[p] = 1; out.push(p); }
            }
          } catch (e) {}
        }
      }
    } catch (e) {}
  }
  try { scan(seq.videoTracks); } catch (e) {}
  try { scan(seq.audioTracks); } catch (e) {}
  return out;
}

function yanta_getProjectItems() {
  try {
    if (!app.project || !app.project.rootItem) return _err('no project');
    var out = [];
    _collectItems(app.project.rootItem, '', out);
    return _ok('[' + out.join(',') + ']');
  } catch (e) { return _err(e); }
}

function yanta_getSequenceMediaMap() {
  try {
    if (!app.project) return _err('no project');
    var p = app.project;
    var out = [];
    for (var i = 0; i < p.sequences.numSequences; i++) {
      var s = p.sequences[i];
      var name = ''; try { name = String(s.name); } catch (e) {}
      var media = _seqMediaPaths(s);
      var arr = [];
      for (var k = 0; k < media.length; k++) arr.push(_str(media[k]));
      out.push('{"name":' + _str(name) + ',"media":[' + arr.join(',') + ']}');
    }
    return _ok('[' + out.join(',') + ']');
  } catch (e) { return _err(e); }
}

function yanta_applyOrganize(json) {
  try {
    if (!app.project || !app.project.rootItem) return _err('no project');
    var root = app.project.rootItem;
    var plan = _parse(json);
    var bins = plan.bins || [];
    var moves = plan.moves || [];
    var created = 0, moved = 0, failed = 0;
    // ① bin 생성(경로 캐시).
    var cache = {};
    for (var b = 0; b < bins.length; b++) {
      var bin = _ensureBinPath(root, bins[b]);
      if (bin) { cache[bins[b]] = bin; created++; }
    }
    // ② 이동.
    for (var m = 0; m < moves.length; m++) {
      var mv = moves[m];
      try {
        var dest = cache[mv.binPath] || _ensureBinPath(root, mv.binPath);
        var pi = _findPiByNodeId(root, String(mv.nodeId));
        if (dest && pi && typeof pi.moveBin === 'function') { pi.moveBin(dest); moved++; }
        else failed++;
      } catch (e) { failed++; }
    }
    return _ok('{"created":' + created + ',"moved":' + moved + ',"failed":' + failed + '}');
  } catch (e) { return _err(e); }
}

function yanta_hostVersion() { return _ok(_str(YANTA_HOST_VER)); }

function yanta_diagAudioScan() {
  try {
    var seq = _activeSeq();
    if (!seq) return _ok(_str('no active sequence (app.project.activeSequence null)'));
    var t0 = (new Date()).getTime();
    var nT = seq.audioTracks.numTracks;
    var msT = (new Date()).getTime() - t0;
    var tr = seq.audioTracks[0];
    var t1 = (new Date()).getTime();
    var nI = tr.clips.numItems;
    var msI = (new Date()).getTime() - t1;
    var n = Math.min(20, nI);
    var t2 = (new Date()).getTime();
    for (var i = 0; i < n; i++) { var c = tr.clips[i]; var a = c.start.seconds, b = c.end.seconds, k = String(c.start.ticks), d = c.disabled, ip = c.inPoint.seconds; }
    var msF = (new Date()).getTime() - t2;
    var t3 = (new Date()).getTime();
    for (var j = 0; j < n; j++) { var p2 = ''; try { p2 = tr.clips[j].projectItem.getMediaPath(); } catch (ep) {} }
    var msP = (new Date()).getTime() - t3;
    return _ok(_str('host=' + YANTA_HOST_VER + ' tracks=' + nT + '(' + msT + 'ms) A1items=' + nI + '(' + msI + 'ms) 20fields=' + msF + 'ms 20paths=' + msP + 'ms'));
  } catch (e) { return _err(e); }
}

// ── Lumetri LUT 직접 지정 ─────────────────────────────────────────
// [문제] yanta_applyLUT은 Lumetri 효과만 붙이고 .cube 경로는 못 넣었다.
//   → 사용자가 드롭다운에서 손으로 골라야 했고, 안 고르면 "적용됐다"고 착각해 룩이 안 걸린 채 진행됨.
// [해결] Lumetri 컴포넌트의 LUT 속성을 찾아 setValue로 경로를 직접 넣는다.
//   버전·언어마다 속성 이름이 달라서 후보를 넓게 잡고, 실패해도 어떤 속성이 있었는지 돌려준다
//   (그 목록을 보고 매칭 규칙을 정확히 좁힐 수 있게).
var _LUT_PROP_RE = /(input\s*lut|creative\s*lut|look|룩|입력\s*lut|lut)/i;

function _setLumetriLut(clip, lutPath) {
  var tried = [];
  if (!clip || !clip.components) return { ok: false, tried: tried };
  for (var k = 0; k < clip.components.numItems; k++) {
    var comp; try { comp = clip.components[k]; } catch (e) { continue; }
    if (!comp || !comp.properties) continue;
    var cname = ''; try { cname = String(comp.displayName || comp.matchName || ''); } catch (e2) {}
    if (!/lumetri|루메트리/i.test(cname)) continue;
    for (var j = 0; j < comp.properties.numItems; j++) {
      var p; try { p = comp.properties[j]; } catch (e3) { continue; }
      var pn = ''; try { pn = String(p.displayName || ''); } catch (e4) {}
      tried.push(pn);
      if (!_LUT_PROP_RE.test(pn)) continue;
      try { p.setValue(lutPath, true); return { ok: true, prop: pn, tried: tried }; } catch (e5) {}
      try { p.setValue(lutPath); return { ok: true, prop: pn, tried: tried }; } catch (e6) {}
    }
  }
  return { ok: false, tried: tried };
}

// 선택 클립들에 Lumetri를 붙이고 LUT 경로까지 지정. 결과 JSON: {applied, lutSet, prop, props}
function yanta_applyLUTFile(lutPath) {
  try {
    var seq = _activeSeq();
    if (!seq) return _err('시퀀스를 먼저 여세요');
    var sel = _selectedClips(seq);
    if (!sel || !sel.length) return _err('타임라인에서 클립을 먼저 선택하세요');

    // ① Lumetri 효과가 없으면 QE로 추가
    app.enableQE();
    var eff = null;
    try { eff = qe.project.getVideoEffectByName('Lumetri Color'); } catch (e0) {}
    if (!eff) { try { eff = qe.project.getVideoEffectByName('루메트리 색상'); } catch (e1) {} }
    var qseq = null; try { qseq = qe.project.getActiveSequence(); } catch (e2) {}
    if (eff && qseq) {
      for (var t = 0; t < qseq.numVideoTracks; t++) {
        var track; try { track = qseq.getVideoTrackAt(t); } catch (e3) { continue; }
        if (!track) continue;
        for (var i = 0; i < track.numItems; i++) {
          var it; try { it = track.getItemAt(i); } catch (e4) { continue; }
          var seld = false; try { seld = it.isSelected(); } catch (e5) {}
          if (seld) { try { it.addVideoEffect(eff); } catch (e6) {} }
        }
      }
    }

    // ② 속성에 .cube 경로 지정 — OS 모양으로. 슬래시로 넘기면 윈도우에서 조용히 안 먹는다
    //    (같은 파일의 exportAsMediaDirect·importMGT 가 그랬다).
    var lutNative = _nativePath(lutPath);
    var applied = 0, lutSet = 0, prop = '', props = [];
    for (var s = 0; s < sel.length; s++) {
      applied++;
      var r = _setLumetriLut(sel[s], lutNative);
      if (r.ok) { lutSet++; prop = r.prop; }
      else if (!props.length) props = r.tried;
    }
    return _ok('{"applied":' + applied + ',"lutSet":' + lutSet
      + ',"prop":' + _str(prop) + ',"props":' + JSON.stringify(props.slice(0, 40)) + '}');
  } catch (e) { return _err(e); }
}

// ── [실측 기록 2026-08-05 · Premiere 26.3.0] 자막 그래픽을 만드는 방법 ─────────
//
// 결론: 캡션→그래픽 변환은 막혀 있지만, MOGRT 경로는 완전히 열려 있다.
//
//  막힌 것 (typeof 직접 확인, 열거 아님)
//   · app.findMenuCommandId → undefined      · app.executeCommand → undefined
//   · sequence.captionTracks → undefined      · qe에도 메뉴 명령 없음
//   → '캡션을 그래픽으로 업그레이드'를 스크립트로 부를 방법이 없다.
//
//  열린 것
//   · sequence.importMGT(_nativePath(path), ticks, vTrack, aTrack) → 그래픽 클립 삽입 ✓
//   · 삽입된 클립의 components 로 전부 접근된다:
//       [불투명도] 불투명도 · 혼합 모드          → 서서히/흐림
//       [모션]     위치 · 비율 조정 · 회전 · 기준점 → 팝 · 날아 들어오기
//       [그래픽 매개 변수] text · position · select
//   · text 파라미터는 JSON 문자열이고 다음 키를 갖는다(실측):
//       textEditValue(글자) · fontEditValue(폰트) · fontSizeEditValue(크기)
//       fontFSBoldValue · fontFSItalicValue · fontFSAllCapsValue
//     → setValue(JSON.stringify(o), true) 로 [글자와 스타일을 함께] 바꿀 수 있다.
//
//  즉 자막 효과의 올바른 경로는 [MOGRT 삽입 → text 파라미터로 글자·폰트·크기 설정 →
//  모션/불투명도 키프레임]이다. 아래 애니메이션 함수는 그 클립들에 그대로 쓰인다.
//
// ── 자막 그래픽 애니메이션 ──────────────────────────────────────────────────
// 그래픽으로 변환된 자막 클립에 입장 애니메이션 키프레임을 찍는다.
//   값 계산은 패널(core/subtitle/captionAnim)이 하고 여기서는 받은 대로 찍기만 한다 —
//   프리미어 안에서 계산하면 눈으로 보기 전엔 맞는지 확인할 방법이 없다.
//
// 파라미터 접근은 오토덕킹에서 라이브 검증된 방식과 같다: 클립 components를 이름으로 훑어
//   Motion(모션)/Opacity(불투명도)를 찾고 setTimeVarying → addKey → setValueAtKey.
//   한글/영문 UI 양쪽에서 찾도록 이름 정규식을 둘 다 넣는다.

function _findParam(clip, compRe, propRe) {
  if (!clip || !clip.components) return null;
  for (var k = 0; k < clip.components.numItems; k++) {
    var comp = clip.components[k];
    if (!comp || !comp.properties) continue;
    if (!compRe.test(comp.displayName || '')) continue;
    for (var j = 0; j < comp.properties.numItems; j++) {
      var pr = comp.properties[j];
      if (propRe.test(pr.displayName || '')) return pr;
    }
  }
  return null;
}

// param 이름 → [컴포넌트 정규식, 속성 정규식]
function _paramLookup(name) {
  if (name === 'scale')    return [/모션|motion/i, /비율|크기조정|scale/i];
  if (name === 'position') return [/모션|motion/i, /위치|position/i];
  if (name === 'opacity')  return [/불투명도|opacity/i, /불투명도|opacity/i];
  if (name === 'blur')     return [/블러|blur/i, /흐림도|blurriness|blur/i];
  return null;
}

// clipsJson = [{start, end, tracks:[{param, keys:[{t, value, interp}]}]}]
//   start/end는 시퀀스 절대 초. 그 시각에 걸치는 그래픽 클립을 찾아 키를 찍는다.
function yanta_animateCaptionGraphics(vTrack, clipsJson) {
  var seq = _activeSeq();
  if (!seq) return _err('no sequence');
  var items; try { items = _parse(clipsJson); } catch (e) { return _err('bad json'); }
  if (!items || !items.length) return _err('적용할 자막이 없어요');
  if (vTrack == null || vTrack < 0 || !seq.videoTracks || vTrack >= seq.videoTracks.numTracks) {
    return _err('비디오 트랙 번호가 범위 밖이에요');
  }
  try {
    var track = seq.videoTracks[vTrack];
    if (!track.clips || !track.clips.numItems) return _err('V' + (vTrack + 1) + ' 트랙에 자막 그래픽이 없어요');

    var applied = 0, missed = 0, noParam = 0;
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var mid = (Number(it.start) + Number(it.end)) / 2;   // 중앙 시각으로 클립을 찾는다(경계 오차에 강함)
      var clip = null;
      for (var c = 0; c < track.clips.numItems; c++) {
        var cl = track.clips[c];
        if (cl.start.seconds <= mid && cl.end.seconds >= mid) { clip = cl; break; }
      }
      if (!clip) { missed++; continue; }

      var didOne = false;
      for (var t = 0; t < (it.tracks || []).length; t++) {
        var tr = it.tracks[t];
        var lookup = _paramLookup(tr.param);
        if (!lookup) continue;
        var prop = _findParam(clip, lookup[0], lookup[1]);
        if (!prop) { noParam++; continue; }
        try { prop.setTimeVarying(true); } catch (e) {}
        for (var q = 0; q < tr.keys.length; q++) {
          var key = tr.keys[q];
          try {
            prop.addKey(key.t);
            prop.setValueAtKey(key.t, key.value, key.interp ? 1 : 0);
            didOne = true;
          } catch (e2) { /* 이 키만 건너뛴다 — 한 클립 때문에 전체가 멈추면 안 된다 */ }
        }
      }
      if (didOne) applied++;
    }
    return _ok('{"applied":' + applied + ',"missed":' + missed + ',"noParam":' + noParam + '}');
  } catch (e) { return _err(e); }
}

// 자막 그래픽이 놓인 트랙 찾기 — '캡션을 그래픽으로' 변환은 새 비디오 트랙을 만든다.
//   가장 위 트랙부터 훑어 그래픽(텍스트) 클립이 가장 많은 트랙을 고른다.
function yanta_findCaptionGraphicTrack() {
  var seq = _activeSeq();
  if (!seq) return _err('no sequence');
  try {
    var best = -1, bestN = 0;
    for (var v = seq.videoTracks.numTracks - 1; v >= 0; v--) {
      var tr = seq.videoTracks[v];
      if (!tr.clips || !tr.clips.numItems) continue;
      var n = 0;
      for (var c = 0; c < tr.clips.numItems; c++) {
        var name = tr.clips[c].name || '';
        // 그래픽 클립은 프로젝트 아이템이 없거나 이름이 자막 텍스트 그대로다.
        var pi = null; try { pi = tr.clips[c].projectItem; } catch (e) {}
        if (!pi || /graphic|그래픽|text|텍스트/i.test(name)) n++;
      }
      if (n > bestN) { bestN = n; best = v; }
    }
    return _ok('{"track":' + best + ',"count":' + bestN + '}');
  } catch (e) { return _err(e); }
}

// 클립 파라미터 덤프 — 그래픽 클립에 어떤 컴포넌트·속성이 노출되는지 실측한다.
//   자막 효과의 Style(폰트·색·외곽선)을 코드로 건드릴 수 있는지가 여기서 갈린다.
//   추측으로 설계하면 프리미어에서 열어보기 전까지 맞는지 알 수 없으므로, 이름을 그대로 받아온다.
function yanta_dumpClipParams(vTrack, clipIndex) {
  var seq = _activeSeq();
  if (!seq) return _err('no sequence');
  try {
    if (!seq.videoTracks || vTrack >= seq.videoTracks.numTracks) return _err('트랙 범위 밖');
    var track = seq.videoTracks[vTrack];
    if (!track.clips || !track.clips.numItems) return _err('트랙에 클립 없음');
    var idx = clipIndex || 0;
    if (idx >= track.clips.numItems) idx = 0;
    var clip = track.clips[idx];
    var comps = [];
    if (clip.components) {
      for (var k = 0; k < clip.components.numItems; k++) {
        var comp = clip.components[k];
        var props = [];
        if (comp.properties) {
          for (var j = 0; j < comp.properties.numItems && j < 30; j++) {
            var pr = comp.properties[j];
            var v = ''; try { v = String(pr.getValue()); } catch (e) { v = '?'; }
            props.push({ name: String(pr.displayName || ''), value: v.slice(0, 40) });
          }
        }
        comps.push({ name: String(comp.displayName || ''), props: props });
      }
    }
    return _ok(JSON.stringify({
      clip: String(clip.name || ''),
      start: clip.start.seconds,
      end: clip.end.seconds,
      components: comps
    }));
  } catch (e) { return _err(e); }
}

// ── MOGRT 자막: 텍스트·스타일 설정 ──────────────────────────────────────────
// 삽입된 MOGRT 클립의 [그래픽 매개 변수] text 파라미터는 JSON이고, 글자와 서체가 같이 들어 있다.
//   실측 구조: textEditValue(글자) · fontEditValue[](폰트) · fontSizeEditValue[](크기)
//              fontFSBoldValue[] · fontFSItalicValue[] · fontFSAllCapsValue[]
//   그래서 자막 한 줄을 넣으면서 스타일까지 한 번에 맞출 수 있다.
// 텍스트 그래픽에는 두 가지 구조가 있다(실측).
//   ① MOGRT의 Essential Graphics: [그래픽 매개 변수] text = JSON(글자 + 서체)
//   ② 프리미어 기본 텍스트 그래픽: [텍스트] 소스 텍스트 = 글자만
// 어느 쪽이 올지 미리 알 수 없으므로 둘 다 찾고, 무엇을 찾았는지 함께 돌려준다.
function _findTextProp(clip) {
  if (!clip) return null;
  var fallback = null;

  // [먼저 MGT 컴포넌트를 본다] MOGRT의 [필수 그래픽] 파라미터는 clip.components 목록에
  //   안 나오는 경우가 있다 — 그래서 getMGTComponent()라는 전용 접근자가 따로 있는 것이다
  //   (이 파일의 _setMogrtColor도 그쪽을 쓴다). 여기를 안 보고 components만 훑으면 MOGRT인데도
  //   글자 칸을 못 찾고 '소스 텍스트'로 떨어진다 — 자막이 빈칸으로 들어가던 경로가 이것이다.
  try {
    if (typeof clip.getMGTComponent === 'function') {
      var mc = clip.getMGTComponent();
      if (mc && mc.properties) {
        for (var m = 0; m < mc.properties.numItems; m++) {
          var mp = mc.properties[m], mv = '';
          try { mv = String(mp.getValue()); } catch (em) { continue; }
          if (mv && mv.indexOf('textEditValue') >= 0) return { prop: mp, kind: 'json' };
        }
      }
    }
  } catch (e0) { /* MOGRT가 아니면 그냥 아래로 */ }

  if (!clip.components) return null;
  // [넓게 훑는 이유] 컴포넌트 이름도, 파라미터 이름도 제작자마다 다르다(그래픽 / Graphics /
  //   TextLayer / 소제목 …). 이름으로 좁히면 템플릿에 따라 조용히 못 찾고 글자가 안 들어간다.
  //   그래서 모든 컴포넌트의 모든 속성을 값으로 훑는다 — textEditValue를 품은 값이면 글자 칸이다.
  for (var k = 0; k < clip.components.numItems; k++) {
    var comp = clip.components[k];
    if (!comp || !comp.properties) continue;
    var cname = String(comp.displayName || '');
    for (var j = 0; j < comp.properties.numItems; j++) {
      var pr = comp.properties[j];
      var v = '';
      try { v = String(pr.getValue()); } catch (e) { v = ''; }
      if (v && v.indexOf('textEditValue') >= 0) return { prop: pr, kind: 'json' };
      if (/텍스트|^text$/i.test(cname) && /소스 텍스트|source text/i.test(String(pr.displayName || ''))) {
        fallback = { prop: pr, kind: 'plain' };
      }
    }
  }
  return fallback;
}

// ⚠️ [절대 쓰지 말 것] '소스 텍스트'(kind:'plain')는 읽기 전용으로만 다룬다.
//   이 속성은 불투명 값이다 — 그냥 읽으면 'ƀ' 같은 글자가 나온다(실측). 여기에 평범한
//   문자열을 setValue 하면 값은 저장되고 되읽히지만(진단으로 확인) 프리미어는 그 형식을
//   렌더에 쓰지 않는다. 결과: 화면의 글자가 통째로 사라진다.
//   실제로 이 경로로 자막을 넣었다가 타임라인의 그래픽이 전부 빈칸이 됐다(실측 사고).
//   그래서 글자를 넣을 수 있는 건 kind:'json'(Essential Graphics)뿐이다.
function _canWriteText(clip) {
  var f = _findTextProp(clip);
  return !!(f && f.kind === 'json');
}

// 클립 신원 — 방금 넣은 클립을 [원래 있던 클립]과 구분하기 위한 열쇠.
function _clipKey(cl) {
  try { if (cl.nodeId) return String(cl.nodeId); } catch (e) {}
  try { return String(cl.start.ticks) + '|' + String(cl.end.ticks) + '|' + String(cl.name || ''); }
  catch (e2) { return String(Math.random()); }
}

// 삽입 [전] 트랙에 있던 클립들을 기억해 둔다.
function _snapClips(track) {
  var seen = {};
  try { for (var i = 0; i < track.clips.numItems; i++) seen[_clipKey(track.clips[i])] = 1; } catch (e) {}
  return seen;
}

// 방금 넣은 클립 찾기.
//   [왜 '가장 가까운 시작'만으로는 안 되나] 같은 시각에 원래 그래픽이 이미 있으면 간격이 0이라
//   그 옛 클립이 먼저 걸린다. 그러면 남의 자막에 글자를 덮어써 망가뜨린다(실측 사고).
//   그래서 삽입 전 스냅샷에 없던 클립 중에서만 고른다.
function _findNewClip(track, seen, atSec) {
  var best = null, bestGap = 1e9;
  try {
    for (var i = 0; i < track.clips.numItems; i++) {
      var cl = track.clips[i];
      if (seen[_clipKey(cl)]) continue;          // 원래 있던 클립 — 건드리지 않는다
      var gap = Math.abs(cl.start.seconds - Number(atSec));
      if (gap < bestGap) { bestGap = gap; best = cl; }
    }
  } catch (e) { return null; }
  return (best && bestGap <= 0.5) ? best : null;
}

// 이 템플릿에 글자를 넣을 수 있는지 [먼저] 확인한다.
//   시퀀스 끝 뒤 빈 곳에 한 개 넣어 보고 바로 지운다. 100개를 넣고 나서야 못 넣는 걸 아는 것보다,
//   1개로 미리 아는 편이 낫다 — 특히 '기존 그래픽 교체'는 원본을 지우고 시작하므로 필수다.
function _probeTextWritable(seq, path, vTrack) {
  var track = seq.videoTracks[vTrack];
  if (!track) return { ok: false, why: '트랙 없음' };
  // 빈 자리에 넣어야 남의 클립을 밀어내지 않는다. seq.end는 이 버전에서 [틱 문자열]이라
  //   .seconds가 없다(NaN이 된다) — 그래서 클립들의 끝 시각을 직접 훑어 최댓값을 쓴다.
  var at = 0;
  try {
    for (var v = 0; v < seq.videoTracks.numTracks; v++) {
      var tk = seq.videoTracks[v];
      for (var i = 0; i < tk.clips.numItems; i++) {
        var e = tk.clips[i].end.seconds;
        if (e > at) at = e;
      }
    }
  } catch (e0) {}
  at = (isFinite(at) && at > 0) ? at + 5 : 3600;

  var seen = _snapClips(track), clip = null;
  try {
    var t = new Time(); t.seconds = at;
    if (!seq.importMGT(_nativePath(String(path)), t.ticks, vTrack, 0)) return { ok: false, why: '템플릿을 넣지 못했어요' };
    clip = _findNewClip(track, seen, at);
  } catch (e2) { return { ok: false, why: String(e2) }; }
  if (!clip) return { ok: false, why: '넣은 템플릿을 다시 찾지 못했어요' };
  var writable = _canWriteText(clip);
  try { clip.remove(false, false); } catch (e3) {}   // 시험용 클립은 반드시 치운다
  return writable ? { ok: true } : { ok: false, why:
    '이 템플릿은 글자 칸이 열려 있지 않아요 — 만든 사람이 [필수 그래픽]에 텍스트를 노출하지 않은 템플릿입니다. '
    + '글자가 빈 채로 수십 개가 들어가는 걸 막으려고 넣지 않았어요. 다른 템플릿을 골라 주세요.' };
}

// 진단 — 이 클립에 어떤 컴포넌트/속성이 있고 무엇이 글자 칸으로 잡히는지 그대로 보여준다.
//   글자가 안 들어갈 때 추측하지 않고 확인하기 위한 것.
function yanta_diagTextParam(vTrack, clipIndex) {
  var seq = _activeSeq();
  if (!seq) return _err('no sequence');
  try {
    var t = seq.videoTracks[vTrack];
    if (!t || !t.clips.numItems) return _err('클립 없음');
    var c = t.clips[Math.min(clipIndex || 0, t.clips.numItems - 1)];
    var rows = [];
    for (var k = 0; k < c.components.numItems; k++) {
      var comp = c.components[k];
      if (!comp.properties) continue;
      for (var j = 0; j < comp.properties.numItems && j < 40; j++) {
        var pr = comp.properties[j], v = '';
        try { v = String(pr.getValue()); } catch (e) { v = '<읽기실패>'; }
        rows.push({
          comp: String(comp.displayName || ''),
          prop: String(pr.displayName || ''),
          head: v.slice(0, 50),
          hasText: v.indexOf('textEditValue') >= 0
        });
      }
    }
    var f = _findTextProp(c);
    return _ok(JSON.stringify({ clip: String(c.name || ''), found: f ? f.kind : 'none', rows: rows }));
  } catch (e) { return _err(e); }
}

// 이 클립에 글자를 넣을 수 있는지 — 넣기 전에 알려주기 위한 것.
function yanta_canSetText(vTrack, clipIndex) {
  var seq = _activeSeq();
  if (!seq) return _err('no sequence');
  try {
    var t = seq.videoTracks[vTrack];
    if (!t || !t.clips.numItems) return _err('클립 없음');
    var c = t.clips[Math.min(clipIndex || 0, t.clips.numItems - 1)];
    var f = _findTextProp(c);
    return _ok(f ? f.kind : 'none');
  } catch (e) { return _err(e); }
}

// 예전 이름 유지 — 애니메이션 쪽에서 참조한다.
function _mogrtTextProp(clip) {
  var f = _findTextProp(clip);
  return (f && f.kind === 'json') ? f.prop : null;
}

// style = {font, size, bold, italic, allCaps} — 지정한 것만 바꾸고 나머지는 템플릿 값을 지킨다.
//   템플릿 제작자가 잡아둔 색·외곽선·애니메이션을 함부로 덮지 않기 위해서다.
function _setMogrtText(clip, text, style) {
  var f = _findTextProp(clip);
  if (!f) return 'noprop';
  // '소스 텍스트'에는 쓰지 않는다 — 값은 들어가지만 화면 글자가 사라진다(_canWriteText 주석 참조).
  if (f.kind === 'plain') return 'readonly';
  var pr = f.prop, o;
  try { o = JSON.parse(String(pr.getValue())); } catch (e) { return 'badjson'; }
  o.textEditValue = String(text);
  if (style) {
    var n = (o.fontEditValue && o.fontEditValue.length) ? o.fontEditValue.length : 1;
    var fill = function (v) { var a = []; for (var i = 0; i < n; i++) a.push(v); return a; };
    if (style.font) o.fontEditValue = fill(String(style.font));
    if (style.size) o.fontSizeEditValue = fill(Number(style.size));
    if (typeof style.bold === 'boolean') o.fontFSBoldValue = fill(style.bold);
    if (typeof style.italic === 'boolean') o.fontFSItalicValue = fill(style.italic);
    if (typeof style.allCaps === 'boolean') o.fontFSAllCapsValue = fill(style.allCaps);
  }
  try { pr.setValue(JSON.stringify(o), true); return 'ok'; } catch (e2) { return 'setfail'; }
}

// 자막 전체를 MOGRT로 삽입 — 컷백식 애니메이션 자막의 실제 경로.
//   jsonStr = { path, vTrack, style, cues:[{start,end,text}] }
//   길이는 삽입 후 end에 맞춰 자른다(MOGRT 기본 길이는 템플릿마다 다르다).
function yanta_insertMogrtSubtitles(jsonStr) {
  var seq = _activeSeq();
  if (!seq) return _err('no sequence');
  var d; try { d = _parse(jsonStr); } catch (e) { return _err('bad json'); }
  if (!d || !d.path || !d.cues || !d.cues.length) return _err('템플릿과 자막이 필요해요');
  if (typeof seq.importMGT !== 'function') return _err('이 Premiere 버전은 MOGRT 삽입 API가 없어요');

  var vTrack = (d.vTrack == null) ? (seq.videoTracks.numTracks - 1) : d.vTrack;

  // [두 갈래] 패널이 줄마다 path를 줬다면 글자가 이미 파일에 구워져 있다(Premiere 제작 템플릿).
  //   그때는 넣기만 하면 되고, 클립에 글자를 쓰려 해선 안 된다 — 쓸 수 있는 칸이 아예 없다.
  var baked = !!(d.cues[0] && d.cues[0].path);
  if (!baked) {
    // 넣기 전에 이 템플릿이 글자를 받을 수 있는지 1개로 확인한다 — 못 받으면 수십 개가 빈칸으로 들어간다.
    var probe = _probeTextWritable(seq, d.path, vTrack);
    if (!probe.ok) return _err(probe.why);
  }

  // [세는 칸을 겹치지 않게] 예전에는 importMGT 가 되면 inserted++ 하고, 그다음 클립을 못 찾으면
  //   failed++ 도 했다. 한 줄이 양쪽에 들어가 합이 요청한 개수를 넘었다.
  //   지금은 한 줄이 정확히 한 칸에만 들어간다:
  //     inserted = 넣고 길이까지 맞춘 것 · orphan = 넣긴 했는데 못 찾아 손대지 못한 것 · failed = 못 넣은 것
  //   orphan 은 타임라인에 기본 길이(대개 5초)로 남아 다음 자막과 겹친다 — 조용히 넘기면 안 된다.
  var inserted = 0, textOk = 0, failed = 0, orphan = 0, lastErr = '';

  for (var i = 0; i < d.cues.length; i++) {
    var c = d.cues[i];
    try {
      var track = seq.videoTracks[vTrack];
      var seen = _snapClips(track);   // 원래 있던 클립 기억 — 남의 자막을 덮어쓰지 않기 위해
      // importMGT(경로, 시작틱, 비디오트랙, 오디오트랙) — 시작은 초가 아니라 틱 문자열.
      var t = new Time(); t.seconds = Number(c.start);
      if (!seq.importMGT(_nativePath(String(c.path || d.path)), t.ticks, vTrack, 0)) { failed++; continue; }
      var clip = _findNewClip(track, seen, c.start);
      if (!clip) { orphan++; continue; }
      inserted++;
      // 길이 맞추기 — 다음 자막을 넣기 [전에] 줄여야 겹치지 않는다.
      try { var e2 = new Time(); e2.seconds = Number(c.end); clip.end = e2; } catch (eLen) {}
      if (c.path) textOk++;                                       // 글자는 파일에 이미 들어 있다
      else if (_setMogrtText(clip, c.text, d.style) === 'ok') textOk++;
    } catch (e3) { failed++; lastErr = String(e3); }
  }
  return _ok('{"inserted":' + inserted + ',"textOk":' + textOk + ',"failed":' + failed
    + ',"orphan":' + orphan + ',"total":' + d.cues.length
    + ',"track":' + vTrack + ',"lastErr":' + _str(lastErr) + '}');
}

// ── 기존 그래픽 자막을 MOGRT로 갈아끼우기 ───────────────────────────────────
// 이미 타임라인에 있는 텍스트 그래픽(선택했거나 트랙 전체)을 읽어 [글자와 시간]을 보존한 채
//   원하는 MOGRT 템플릿으로 다시 넣는다. 자막을 다시 만들 필요가 없다.

// 그래픽 클립에서 글자를 읽는다. MOGRT든 프리미어 기본 텍스트 그래픽이든 같은
//   [그래픽 매개 변수] text(JSON) 구조를 쓴다(실측).
function _readGraphicText(clip) {
  var f = _findTextProp(clip);
  if (!f) return null;
  try {
    var raw = String(f.prop.getValue());
    if (f.kind === 'plain') {
      // 기본 텍스트 그래픽의 '소스 텍스트'는 불투명 값이라 그대로 읽으면 'ƀ' 같은 글자가 나온다(실측).
      //   프리미어는 텍스트 그래픽 클립의 이름을 그 내용으로 짓는다 — 그쪽이 훨씬 믿을 만하다.
      if (raw && raw.length > 1 && raw.indexOf('\u0180') < 0) return raw;
      var nm = String(clip.name || '');
      // \uc774\ub984\uc774 \ub0b4\uc6a9\uc744 \ub2f4\uace0 \uc788\uc744 \ub54c\ub9cc \uc4f4\ub2e4. \ud504\ub9ac\ubbf8\uc5b4\uac00 \ubd99\uc774\ub294 \uc77c\ubc18 \uc774\ub984(\uadf8\ub798\ud53d / Graphic 3 \u2026)\uc744
      //   \uc790\ub9c9\uc73c\ub85c \ucc29\uac01\ud558\uba74 "\uadf8\ub798\ud53d"\uc774\ub77c\uace0 \uc801\ud78c \uc790\ub9c9\uc774 \uc904\uc904\uc774 \ub4e4\uc5b4\uac04\ub2e4.
      if (!nm || /^(\uadf8\ub798\ud53d|graphic|\ud14d\uc2a4\ud2b8|text|\uae30\ubcf8 \uadf8\ub798\ud53d)\s*\d*$/i.test(nm)) return null;
      return nm;
    }
    var o = JSON.parse(raw);
    return (typeof o.textEditValue === 'string') ? o.textEditValue : null;
  } catch (e) { return null; }
}

// vTrack 트랙의 그래픽 자막을 훑는다. selectedOnly면 선택된 클립만.
function yanta_readGraphicTexts(vTrack, selectedOnly) {
  var seq = _activeSeq();
  if (!seq) return _err('no sequence');
  try {
    if (vTrack == null || vTrack < 0 || vTrack >= seq.videoTracks.numTracks) return _err('트랙 번호 범위 밖');
    var track = seq.videoTracks[vTrack], out = [];
    for (var i = 0; i < track.clips.numItems; i++) {
      var c = track.clips[i];
      if (selectedOnly && !c.isSelected()) continue;
      var t = _readGraphicText(c);
      if (t === null) continue;   // 텍스트 그래픽이 아닌 클립은 건너뛴다(영상·이미지 보호)
      out.push({ start: c.start.seconds, end: c.end.seconds, text: t });
    }
    return _ok(JSON.stringify(out));
  } catch (e) { return _err(e); }
}

// 트랙마다 텍스트 그래픽이 몇 개 있는지 — 패널이 [어느 트랙]을 스스로 고르게 하려는 것.
//   사람이 V2를 고른 채 "못 찾았어요"만 보는 일을 없앤다. 자막은 V3에 있는데.
function yanta_countGraphicTextTracks() {
  var seq = _activeSeq();
  if (!seq) return _err('no sequence');
  try {
    var out = [];
    for (var v = 0; v < seq.videoTracks.numTracks; v++) {
      var track = seq.videoTracks[v], n = 0, sel = 0, mute = 0;
      for (var i = 0; i < track.clips.numItems; i++) {
        var c = track.clips[i];
        if (!_findTextProp(c)) continue;          // 글자 칸이 없으면 텍스트 그래픽이 아니다
        if (_readGraphicText(c) === null) {
          // 글자 칸은 있는데 읽히지 않는다 — Premiere 제작 템플릿으로 넣은 그래픽이 이렇다.
          //   ('소스 텍스트'가 불투명 값이라 무슨 글자인지 알 수 없다.)
          //   0개라고만 하면 왜 안 되는지 알 수 없으므로 따로 센다.
          mute++;
          continue;
        }
        n++;
        try { if (c.isSelected()) sel++; } catch (e2) {}
      }
      // [트랙 눈이 꺼져 있으면 넣어도 화면에 안 보인다]
      //   자막은 정상적으로 들어가는데 프로그램 모니터에는 아무것도 없다 — 사람은 플러그인이
      //   고장 났다고 판단하게 된다(실측으로 이 상황을 만나 한참 헤맸다). 그래서 함께 알려준다.
      var hidden = false;
      try { hidden = !!track.isMuted(); } catch (e3) { hidden = false; }
      out.push({ track: v, count: n, selected: sel, unreadable: mute, hidden: hidden });
    }
    return _ok(JSON.stringify(out));
  } catch (e) { return _err(e); }
}

// 트랙의 눈(표시)을 켜고 끈다. 꺼진 트랙에 자막을 넣으면 화면에 안 보이므로, 패널이 한 번에
//   켜줄 수 있어야 한다 — 사람이 프리미어에서 눈 아이콘을 찾아 누르게 하는 것보다 낫다.
function yanta_setTrackVisible(vTrack, on) {
  var seq = _activeSeq();
  if (!seq) return _err('no sequence');
  try {
    var t = seq.videoTracks[vTrack];
    if (!t) return _err('트랙 번호 범위 밖');
    t.setMute(on ? 0 : 1);
    var now = false;
    try { now = !!t.isMuted(); } catch (e2) {}
    return _ok('{"hidden":' + (now ? 'true' : 'false') + '}');
  } catch (e) { return _err(e); }
}

// 텍스트 그래픽 클립만 지운다 — 교체의 [지우는] 단계.
//   교체를 한 함수에 몰아두면, 글자를 파일에 구워 넣는 템플릿(Premiere 제작)을 다룰 수 없다.
//   그쪽은 패널이 줄마다 다른 파일을 만들어 넘겨야 하기 때문에 [읽기 → 굽기 → 지우기 → 넣기]로 나눈다.
//   그래서 이 함수는 [지우기]만 한다. 넣기는 yanta_insertMogrtSubtitles가 이어서 한다.
function yanta_removeGraphicClips(vTrack, selectedOnly) {
  var seq = _activeSeq();
  if (!seq) return _err('no sequence');
  try {
    if (vTrack == null || vTrack < 0 || vTrack >= seq.videoTracks.numTracks) return _err('트랙 번호 범위 밖');
    var track = seq.videoTracks[vTrack], victims = [];
    for (var i = 0; i < track.clips.numItems; i++) {
      var c = track.clips[i];
      if (selectedOnly && !c.isSelected()) continue;
      if (_readGraphicText(c) === null) continue;   // 영상·이미지 클립은 건드리지 않는다
      victims.push(c);
    }
    var removed = 0;
    // 뒤에서부터 지워야 인덱스가 밀리지 않는다.
    for (var v = victims.length - 1; v >= 0; v--) {
      try { victims[v].remove(false, false); removed++; } catch (e2) {}
    }
    return _ok('{"removed":' + removed + '}');
  } catch (e) { return _err(e); }
}

// jsonStr = { path, vTrack, targetTrack, selectedOnly, style }
//   vTrack에서 읽고, targetTrack(미지정이면 같은 트랙)에 MOGRT로 다시 넣는다.
//   원본 클립은 새로 넣기 [전에] 지운다 — 같은 트랙에 겹쳐 넣으면 삽입이 실패한다.
function yanta_replaceGraphicsWithMogrt(jsonStr) {
  var seq = _activeSeq();
  if (!seq) return _err('no sequence');
  var d; try { d = _parse(jsonStr); } catch (e) { return _err('bad json'); }
  if (!d || !d.path) return _err('템플릿 경로가 필요해요');
  if (typeof seq.importMGT !== 'function') return _err('이 Premiere 버전은 MOGRT 삽입 API가 없어요');

  var src = d.vTrack;
  if (src == null || src < 0 || src >= seq.videoTracks.numTracks) return _err('원본 트랙 번호 범위 밖');
  var dst = (d.targetTrack == null) ? src : d.targetTrack;
  if (dst < 0 || dst >= seq.videoTracks.numTracks) return _err('넣을 트랙 번호 범위 밖');

  try {
    // ① 글자와 시간 먼저 확보 — 지우고 나면 되돌릴 수 없다.
    var track = seq.videoTracks[src], cues = [], victims = [];
    for (var i = 0; i < track.clips.numItems; i++) {
      var c = track.clips[i];
      if (d.selectedOnly && !c.isSelected()) continue;
      var t = _readGraphicText(c);
      if (t === null) continue;
      cues.push({ start: c.start.seconds, end: c.end.seconds, text: t });
      victims.push(c);
    }
    if (!cues.length) return _err('바꿀 텍스트 그래픽을 찾지 못했어요 (트랙·선택을 확인해 주세요)');

    // ①-b 지우기 [전에] 새 템플릿이 글자를 받을 수 있는지 확인한다.
    //   이 함수는 원본을 지우고 시작한다 — 나중에 못 넣는 걸 알면 자막이 통째로 날아간다.
    var probe = _probeTextWritable(seq, d.path, dst);
    if (!probe.ok) return _err(probe.why + ' (원본은 그대로 두었어요)');

    // ② 원본 제거 — 뒤에서부터 지워야 인덱스가 밀리지 않는다.
    var removed = 0;
    for (var v = victims.length - 1; v >= 0; v--) {
      try { victims[v].remove(false, false); removed++; } catch (e2) {}
    }

    // ③ 같은 시간·같은 글자로 MOGRT 삽입.
    var inserted = 0, textOk = 0;
    for (var q = 0; q < cues.length; q++) {
      try {
        var dt = seq.videoTracks[dst];
        var seen2 = _snapClips(dt);
        var tt = new Time(); tt.seconds = Number(cues[q].start);
        if (!seq.importMGT(_nativePath(String(d.path)), tt.ticks, dst, 0)) continue;
        inserted++;
        var clip = _findNewClip(dt, seen2, cues[q].start);
        if (!clip) continue;
        try { var e3 = new Time(); e3.seconds = Number(cues[q].end); clip.end = e3; } catch (eL) {}
        if (_setMogrtText(clip, cues[q].text, d.style) === 'ok') textOk++;
      } catch (e4) {}
    }
    return _ok('{"found":' + cues.length + ',"removed":' + removed
      + ',"inserted":' + inserted + ',"textOk":' + textOk + ',"track":' + dst + '}');
  } catch (e) { return _err(e); }
}

// ── 단어 강조 자막 ──────────────────────────────────────────────────────────
// 조각마다 그래픽을 하나씩 넣고, 그 순간 말하는 단어에만 다른 서식을 준다.
//   글자 서식은 [런 배열]로 표현된다 — fontTextRunLength[]가 각 런의 글자 수이고,
//   fontEditValue[] · fontSizeEditValue[] · fontFSBoldValue[] 가 런마다 하나씩 대응한다(실측).
//   런 길이의 합이 글자 수와 어긋나면 서식이 밀리므로, 패널에서 계산해 검증한 값만 받는다.

function _setRunText(clip, line, runs, base, hi) {
  var f = _findTextProp(clip);
  if (!f) return 'noprop';
  // 여기도 '소스 텍스트'에는 쓰지 않는다 — 강조는커녕 글자 자체가 사라진다.
  if (f.kind === 'plain') return 'readonly';
  var o;
  try { o = JSON.parse(String(f.prop.getValue())); } catch (e) { return 'badjson'; }

  var lens = [], fonts = [], sizes = [], bolds = [], italics = [], caps = [], smalls = [];
  for (var i = 0; i < runs.length; i++) {
    var r = runs[i], on = !!r.active;
    lens.push(Number(r.length));
    fonts.push(String((on && hi && hi.font) ? hi.font : (base && base.font ? base.font : (o.fontEditValue && o.fontEditValue[0]) || '')));
    sizes.push(Number((on && hi && hi.size) ? hi.size : (base && base.size ? base.size : (o.fontSizeEditValue && o.fontSizeEditValue[0]) || 55)));
    bolds.push(on ? ((hi && typeof hi.bold === 'boolean') ? hi.bold : true) : !!(base && base.bold));
    italics.push(on ? !!(hi && hi.italic) : !!(base && base.italic));
    caps.push(false); smalls.push(false);
  }

  o.textEditValue = String(line);
  o.capPropTextRunCount = lens.length;
  o.fontTextRunLength = lens;
  o.fontEditValue = fonts;
  o.fontSizeEditValue = sizes;
  o.fontFSBoldValue = bolds;
  o.fontFSItalicValue = italics;
  o.fontFSAllCapsValue = caps;
  o.fontFSSmallCapsValue = smalls;
  try { f.prop.setValue(JSON.stringify(o), true); return 'ok'; } catch (e2) { return 'setfail'; }
}

// jsonStr = { path, vTrack, base:{font,size,bold}, highlight:{font,size,bold}, segs:[{start,end,line,runs}] }
function yanta_insertKaraoke(jsonStr) {
  var seq = _activeSeq();
  if (!seq) return _err('no sequence');
  var d; try { d = _parse(jsonStr); } catch (e) { return _err('bad json'); }
  if (!d || !d.path || !d.segs || !d.segs.length) return _err('템플릿과 자막이 필요해요');
  if (typeof seq.importMGT !== 'function') return _err('이 Premiere 버전은 MOGRT 삽입 API가 없어요');

  var vTrack = (d.vTrack == null) ? (seq.videoTracks.numTracks - 1) : d.vTrack;

  // 첫 묶음에서만 확인한다 — 패널이 20조각씩 나눠 부르므로 매번 시험하면 낭비다.
  if (d.first) {
    var probe = _probeTextWritable(seq, d.path, vTrack);
    if (!probe.ok) return _err(probe.why);
  }

  var inserted = 0, styled = 0, failed = 0, plain = 0;
  // [30초 제한] evalScript 한 번에 100개를 넣으면 응답이 끊긴다(실측). 패널이 조각을 나눠
  //   여러 번 부르고, 여기서는 받은 만큼만 처리한다.
  for (var i = 0; i < d.segs.length; i++) {
    var g = d.segs[i];
    try {
      var track = seq.videoTracks[vTrack];
      var seen = _snapClips(track);
      var t = new Time(); t.seconds = Number(g.start);
      if (!seq.importMGT(_nativePath(String(d.path)), t.ticks, vTrack, 0)) { failed++; continue; }
      inserted++;
      var clip = _findNewClip(track, seen, g.start);
      if (!clip) { failed++; continue; }
      try { var e2 = new Time(); e2.seconds = Number(g.end); clip.end = e2; } catch (eL) {}
      var r = _setRunText(clip, g.line, g.runs || [], d.base, d.highlight);
      if (r === 'ok') styled++; else plain++;
    } catch (e3) { failed++; }
  }
  return _ok('{"inserted":' + inserted + ',"styled":' + styled + ',"plain":' + plain
    + ',"failed":' + failed + ',"track":' + vTrack + '}');
}
