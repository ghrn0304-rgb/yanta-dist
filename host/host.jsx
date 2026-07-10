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
function _findWavPreset() {
  var base = app.path;
  if (base.charAt(base.length - 1) !== '/') base += '/';
  var dirs = ['Contents/Settings/EncoderPresets/', 'MediaIO/presets/'];
  var names = ['WAV_Mono_16bit_16kHz.epr', 'Wave48mono16.epr', 'Wave48mono24.epr', 'Wave96mono16.epr', 'WAV.epr'];
  for (var d = 0; d < dirs.length; d++) {
    for (var n = 0; n < names.length; n++) {
      var f = new File(base + dirs[d] + names[n]);
      if (f.exists) return f;
    }
  }
  return null;
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
    if (safeDir.charAt(safeDir.length - 1) === '/') safeDir = safeDir.slice(0, -1);
    var safePath = safeDir + '/' + fileName;

    // [2a] 프리셋(.epr) 유효성 검증 — 없으면 사일런트 크래시 → 명확 에러.
    var preset = _findWavPreset();
    if (!preset || !preset.exists) return _err('WAV 인코더 프리셋(.epr)을 찾을 수 없음 — Premiere EncoderPresets 폴더 확인');

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

    // 스테일 파일 제거(이전 실패 잔여)
    try { var old = new File(safePath); if (old.exists) old.remove(); } catch (er) {}

    // [실행] 정석 export. 반환 boolean은 신뢰 불가 → 파일 실존으로 최종 판정.
    seq.exportAsMediaDirect(safePath, preset.fsName, workArea);

    var outFile = new File(safePath);
    if (!outFile.exists || outFile.length <= 0) {
      return _err('렌더 호출됐으나 오디오 파일 미생성(빈 출력) — 시퀀스에 오디오 트랙/클립이 있는지 확인');
    }
    return _ok(_str(safePath)); // [3] 실제 쓰여진 경로 반환(JS가 이 경로의 WAV를 읽음)
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
    var ok = app.project.exportFinalCutProXML(outputPath);
    var nm = app.project.activeSequence ? app.project.activeSequence.name : '';
    return _ok('{"ok":' + (ok ? 'true' : 'false') + ',"seq":' + _str(nm) + '}');
  } catch (e) { return _err(e); }
}

// 시퀀스 in-point (초). useInOut STT 시 타임스탬프 오프셋용.
function yanta_getInPoint() {
  var seq = _activeSeq();
  if (!seq) return _ok('0');
  try { var ip = seq.getInPoint(); return _ok(String(Number(ip))); }
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
    var ok = app.project.importFiles([path], true, app.project.getInsertionBin ? app.project.getInsertionBin() : app.project.rootItem, false);
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
      app.project.importFiles([path], true, app.project.getInsertionBin ? app.project.getInsertionBin() : app.project.rootItem, false);
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
      app.project.importFiles([path], true, app.project.getInsertionBin ? app.project.getInsertionBin() : app.project.rootItem, false);
      pi = _findPiByPath(app.project.rootItem, path);
    }
    if (!pi) return _err('SRT 임포트 실패 (미디어 캐시 오류 가능 — 재시도)');
    seq.createCaptionTrack(pi, '0');
    var names = ['Upgrade Captions to Graphic', 'Upgrade Caption to Graphic', 'Upgrade to Graphic', 'Captions to Graphic'];
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
    app.project.importFiles([path], true, app.project.getInsertionBin ? app.project.getInsertionBin() : app.project.rootItem, false);
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
function yanta_listMogrtTemplates() {
  var roots = [
    '~/Library/Application Support/Adobe/Common/Motion Graphics Templates',
    '~/Documents/Adobe/Premiere Pro/Motion Graphics Templates',
    '~/Library/Application Support/Yanta/mogrt'
  ];
  var out = [], seen = {};
  try {
    for (var r = 0; r < roots.length; r++) { _scanMogrt(new Folder(roots[r]), out, seen, 0); }
  } catch (e) { return _err(e); }
  return _ok('[' + out.join(',') + ']');
}
function _scanMogrt(folder, out, seen, depth) {
  if (!folder || !folder.exists || depth > 2) return;
  var items;
  try { items = folder.getFiles(); } catch (e) { return; }
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    if (it instanceof Folder) { _scanMogrt(it, out, seen, depth + 1); }
    else if (/\.mogrt$/i.test(it.name) && !seen[it.fsName]) {
      seen[it.fsName] = 1;
      var nm = it.name; try { nm = decodeURIComponent(it.name); } catch (e) {}
      nm = nm.replace(/\.mogrt$/i, '');
      out.push('{"name":' + _str(nm) + ',"path":' + _str(it.fsName) + '}');
    }
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
    var clip = seq.importMGT(o.path, ticks, vTrack, -1);
    if (!clip || typeof clip.getMGTComponent !== 'function') clip = _findClipAt(seq.videoTracks[vTrack], at);
    if (!clip) return _err('MOGRT 삽입 실패 (경로/트랙 확인)');
    if (o.text) _setMogrtText(clip, o.text);
    if (o.durSec && o.durSec > 0) _setClipEnd(clip, at + o.durSec);
    return _ok('true');
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
      try { clip = seq.importMGT(o.path, ticks, vT, -1); } catch (e) { failed++; continue; }
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
      try { clip = seq.importMGT(o.path, ticks, vTrack, -1); } catch (e) { failed++; continue; }
      if (!clip || typeof clip.getMGTComponent !== 'function') clip = _findClipAt(seq.videoTracks[vTrack], at);
      if (clip) { if (s.text) _setMogrtText(clip, s.text); _setClipEnd(clip, s.end); done++; }
      else failed++;
    }
    return _ok('{"inserted":' + done + ',"failed":' + failed + '}');
  } catch (e) { return _err(e); }
}
