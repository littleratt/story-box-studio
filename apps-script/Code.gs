/**
 * Story Box — Studio back end (Google Apps Script)
 *
 * Keeps the story library in a Google Drive folder called "Story Box":
 *   Story Box/library.json          which stories exist, their chapters and covers, which figure plays what
 *   Story Box/stories/<story id>/   the MP3 chapters and cover picture of each story
 *   Story Box/firmware/             box software updates uploaded from the Studio
 *
 * Two kinds of callers, each with its own secret key:
 *   - the Studio page (STUDIO_KEY): create stories, upload chapters and covers, assign figures
 *   - the Story Box itself (BOX_KEY): read the list of stories, download files, report what it has seen
 * The box key can only read story files; it can't change anything except the box's own status.
 *
 * One-time setup: run setup() from the editor, then Deploy > New deployment > Web app,
 * "Execute as: Me", "Who has access: Anyone". See SETUP.md.
 */

const P = PropertiesService.getScriptProperties();
const CHUNK = 2 * 1024 * 1024;  // upload piece size (Drive needs multiples of 256 KB)

// ---------------------------------------------------------------- setup

function setup() {
  const root = root_();
  ['STUDIO_KEY', 'BOX_KEY'].forEach(function (k) {
    if (!P.getProperty(k)) P.setProperty(k, Utilities.getUuid().replace(/-/g, ''));
  });
  // Touch the Drive REST API once so Google asks for all permissions now, not later.
  UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/about?fields=user',
    { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() } });
  Logger.log('Drive folder: ' + root.getUrl());
  Logger.log('STUDIO_KEY (for the Studio page): ' + P.getProperty('STUDIO_KEY'));
  Logger.log('BOX_KEY (for the Story Box SD card): ' + P.getProperty('BOX_KEY'));
}

// ---------------------------------------------------------------- web entry points

// GET: used by the box (simple for a small device to call).
//   ?a=manifest&k=BOX_KEY
//   ?a=file&k=BOX_KEY&id=FILE_ID&start=0&len=196608   -> that part of the file, as base64 text
function doGet(e) {
  const p = (e && e.parameter) || {};
  try {
    if (p.k !== P.getProperty('BOX_KEY')) return text_('ERR bad key');
    if (p.a === 'manifest') return json_(manifest_(lib_()));
    if (p.a === 'file') return text_(fileChunk_(lib_(), p.id, Number(p.start) || 0, Number(p.len) || 196608));
    return text_('ERR unknown action');
  } catch (err) {
    return text_('ERR ' + err.message);
  }
}

// POST: JSON body {key, action, ...}. Used by the Studio page, and by the box for "report".
function doPost(e) {
  let req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ error: 'bad request' });
  }
  try {
    if (req.key === P.getProperty('STUDIO_KEY')) return json_(studio_(req));
    if (req.key === P.getProperty('BOX_KEY') && req.action === 'report') return json_(report_(req));
    return json_({ error: 'bad key' });
  } catch (err) {
    return json_({ error: err.message });
  }
}

function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function text_(s) { return ContentService.createTextOutput(s).setMimeType(ContentService.MimeType.TEXT); }

// ---------------------------------------------------------------- Drive helpers

function root_() {
  const id = P.getProperty('ROOT_ID');
  if (id) { try { return DriveApp.getFolderById(id); } catch (err) { /* deleted: make a new one */ } }
  const f = DriveApp.createFolder('Story Box');
  P.setProperty('ROOT_ID', f.getId());
  return f;
}

function sub_(parent, name) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

function storyFolder_(sid) { return sub_(sub_(root_(), 'stories'), sid); }

function trash_(fileId) {
  if (!fileId) return;
  try { DriveApp.getFileById(fileId).setTrashed(true); } catch (err) { /* already gone */ }
}

// ---------------------------------------------------------------- library.json

function emptyLib_() { return { stories: {}, figures: {}, box: { seen: {} } }; }

function libFile_() {
  const id = P.getProperty('LIB_ID');
  if (id) { try { const f = DriveApp.getFileById(id); if (!f.isTrashed()) return f; } catch (err) {} }
  const it = root_().getFilesByName('library.json');
  const f = it.hasNext() ? it.next() : root_().createFile('library.json', JSON.stringify(emptyLib_()), 'application/json');
  P.setProperty('LIB_ID', f.getId());
  return f;
}

function lib_() {
  const lib = JSON.parse(libFile_().getBlob().getDataAsString() || '{}');
  const e = emptyLib_();
  lib.stories = lib.stories || e.stories;
  lib.figures = lib.figures || e.figures;
  lib.box = lib.box || e.box;
  lib.box.seen = lib.box.seen || {};
  return lib;
}

// Read, change and save the library while holding a lock, so two saves can't overwrite each other.
function change_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const lib = lib_();
    const result = fn(lib);
    libFile_().setContent(JSON.stringify(lib));
    return result;
  } finally {
    lock.releaseLock();
  }
}

function cleanUid_(uid) {
  const u = String(uid || '').replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  if (u.length < 8 || u.length > 20) throw new Error('That figure ID doesn\'t look right: ' + uid);
  return u;
}

function story_(lib, sid) {
  const s = lib.stories[sid];
  if (!s) throw new Error('Story not found');
  return s;
}

// ---------------------------------------------------------------- Studio actions

function studio_(req) {
  switch (req.action) {
    case 'state': return state_();

    case 'saveStory': return change_(function (lib) {
      let sid = req.sid;
      if (!sid) {
        sid = 's' + Date.now().toString(36);
        storyFolder_(sid);
        lib.stories[sid] = { title: '', chapters: [], coverId: null, coverSize: 0, created: Date.now() };
      }
      const s = story_(lib, sid);
      s.title = String(req.title || 'Untitled story').slice(0, 80);
      s.updated = Date.now();
      return { sid: sid };
    });

    case 'deleteStory': return change_(function (lib) {
      story_(lib, req.sid);
      try { storyFolder_(req.sid).setTrashed(true); } catch (err) {}
      delete lib.stories[req.sid];
      Object.keys(lib.figures).forEach(function (uid) {
        if (lib.figures[uid].storyId === req.sid) lib.figures[uid].storyId = null;
      });
      return { ok: true };
    });

    case 'uploadBegin': return uploadBegin_(req);
    case 'uploadChunk': return uploadChunk_(req);

    case 'addChapter': return change_(function (lib) {
      const s = story_(lib, req.sid);
      const size = DriveApp.getFileById(req.fileId).getSize();
      const ch = { id: req.fileId, size: size, secs: Math.round(Number(req.secs) || 0) };
      const i = Number(req.replace);
      if (req.replace !== undefined && req.replace !== null && i >= 0 && i < s.chapters.length) {
        trash_(s.chapters[i].id);
        s.chapters[i] = ch;
      } else {
        s.chapters.push(ch);
      }
      s.updated = Date.now();
      return { ok: true };
    });

    case 'deleteChapter': return change_(function (lib) {
      const s = story_(lib, req.sid);
      const removed = s.chapters.splice(Number(req.index), 1);
      if (removed.length) trash_(removed[0].id);
      s.updated = Date.now();
      return { ok: true };
    });

    case 'moveChapter': return change_(function (lib) {
      const s = story_(lib, req.sid);
      const i = Number(req.index), j = i + Number(req.delta);
      if (i >= 0 && j >= 0 && i < s.chapters.length && j < s.chapters.length) {
        const t = s.chapters[i]; s.chapters[i] = s.chapters[j]; s.chapters[j] = t;
        s.updated = Date.now();
      }
      return { ok: true };
    });

    case 'setCover': return change_(function (lib) {
      const s = story_(lib, req.sid);
      if (s.coverId && s.coverId !== req.fileId) trash_(s.coverId);
      s.coverId = req.fileId;
      s.coverSize = DriveApp.getFileById(req.fileId).getSize();
      s.updated = Date.now();
      return { ok: true };
    });

    case 'setFigure': return change_(function (lib) {
      const uid = cleanUid_(req.uid);
      if (req.storyId) story_(lib, req.storyId);
      const f = lib.figures[uid] || { added: Date.now() };
      f.name = String(req.name || f.name || 'Figure').slice(0, 40);
      f.storyId = req.storyId || null;
      lib.figures[uid] = f;
      return { uid: uid };
    });

    case 'deleteFigure': return change_(function (lib) {
      delete lib.figures[cleanUid_(req.uid)];
      return { ok: true };
    });

    case 'setFirmware': return change_(function (lib) {
      const v = String(req.version || '').trim();
      if (!/^\d+(\.\d+){1,2}$/.test(v)) throw new Error('Version should look like 2.2');
      const meta = JSON.parse(UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/' +
        encodeURIComponent(req.fileId) + '?fields=md5Checksum,size',
        { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() } }).getContentText());
      if (lib.firmware && lib.firmware.id !== req.fileId) trash_(lib.firmware.id);
      lib.firmware = { v: v, id: req.fileId, size: Number(meta.size), md5: meta.md5Checksum, uploaded: Date.now() };
      return { ok: true };
    });

    case 'getChapter': {
      const s = story_(lib_(), req.sid);
      const ch = s.chapters[Number(req.index)];
      if (!ch) throw new Error('Chapter not found');
      return { b64: Utilities.base64Encode(DriveApp.getFileById(ch.id).getBlob().getBytes()) };
    }
  }
  throw new Error('Unknown action: ' + req.action);
}

function state_() {
  const lib = lib_();
  const stories = Object.keys(lib.stories).map(function (sid) {
    const s = lib.stories[sid];
    let cover = null;
    if (s.coverId) {
      try { cover = Utilities.base64Encode(DriveApp.getFileById(s.coverId).getBlob().getBytes()); } catch (err) {}
    }
    return { sid: sid, title: s.title, chapters: s.chapters, cover: cover, updated: s.updated || s.created };
  }).sort(function (a, b) { return (b.updated || 0) - (a.updated || 0); });
  const figures = Object.keys(lib.figures).map(function (uid) {
    const f = lib.figures[uid];
    return { uid: uid, name: f.name, storyId: f.storyId };
  }).sort(function (a, b) { return a.name.localeCompare(b.name); });
  return { stories: stories, figures: figures, box: lib.box, firmware: lib.firmware || null };
}

// Big files go to Drive in pieces ("resumable upload"), so phones on slow connections
// and long recordings don't hit size limits.
function uploadBegin_(req) {
  let name, mime, folderId, description;
  if (req.kind === 'firmware') {
    name = 'storybox-' + String(req.version || 'new').replace(/[^0-9.]/g, '') + '-' + Date.now() + '.bin';
    mime = 'application/octet-stream';
    folderId = sub_(root_(), 'firmware').getId();
    description = 'Story Box firmware';
  } else {
    const s = story_(lib_(), req.sid);
    const isCover = req.kind === 'cover';
    name = (isCover ? 'cover-' : 'chapter-') + Date.now() + (isCover ? '.jpg' : '.mp3');
    mime = isCover ? 'image/jpeg' : 'audio/mpeg';
    folderId = storyFolder_(req.sid).getId();
    description = s.title;
  }
  const r = UrlFetchApp.fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id', {
    method: 'post',
    contentType: 'application/json; charset=UTF-8',
    headers: {
      Authorization: 'Bearer ' + ScriptApp.getOAuthToken(),
      'X-Upload-Content-Type': mime,
      'X-Upload-Content-Length': String(req.size)
    },
    payload: JSON.stringify({ name: name, parents: [folderId], description: description }),
    muteHttpExceptions: true
  });
  const h = r.getAllHeaders();
  const url = h.Location || h.location;
  if (r.getResponseCode() !== 200 || !url) throw new Error('Drive would not start the upload (' + r.getResponseCode() + ')');
  return { url: url, chunk: CHUNK };
}

function uploadChunk_(req) {
  if (String(req.url).indexOf('https://www.googleapis.com/upload/drive/v3/') !== 0) throw new Error('Bad upload address');
  const bytes = Utilities.base64Decode(req.b64);
  const start = Number(req.start), total = Number(req.total);
  const end = start + bytes.length - 1;
  const r = UrlFetchApp.fetch(req.url, {
    method: 'put',
    contentType: 'application/octet-stream',
    headers: { 'Content-Range': 'bytes ' + start + '-' + end + '/' + total },
    payload: bytes,
    followRedirects: false,   // Drive answers 308 "keep going", which is not a real redirect
    muteHttpExceptions: true
  });
  const code = r.getResponseCode();
  if (code === 308) return { done: false };
  if (code === 200 || code === 201) return { done: true, fileId: JSON.parse(r.getContentText()).id };
  throw new Error('Upload failed (' + code + '): ' + r.getContentText().slice(0, 200));
}

// ---------------------------------------------------------------- Box actions

// What the box should have on its SD card. "v" changes whenever anything changes,
// so the box can skip the details when nothing is new.
function manifest_(lib) {
  const figures = [];
  Object.keys(lib.figures).sort().forEach(function (uid) {
    const f = lib.figures[uid];
    const s = f.storyId && lib.stories[f.storyId];
    if (!s || !s.chapters.length) return;
    const files = s.chapters.map(function (c, i) {
      return { n: (i < 9 ? '0' : '') + (i + 1) + '.mp3', id: c.id, s: c.size };
    });
    if (s.coverId) files.push({ n: 'cover.jpg', id: s.coverId, s: s.coverSize });
    figures.push({ uid: uid, title: s.title, files: files });
  });
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, JSON.stringify(figures));
  const v = digest.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
  const out = { v: v, figures: figures };
  if (lib.firmware) out.fw = { v: lib.firmware.v, id: lib.firmware.id, s: lib.firmware.size, md5: lib.firmware.md5 };
  return out;
}

function fileChunk_(lib, id, start, len) {
  // The box may only download files that belong to a story, or the current firmware.
  let allowed = !!(lib.firmware && lib.firmware.id === id);
  Object.keys(lib.stories).forEach(function (sid) {
    const s = lib.stories[sid];
    if (s.coverId === id) allowed = true;
    s.chapters.forEach(function (c) { if (c.id === id) allowed = true; });
  });
  if (!allowed) return 'ERR not a story file';
  len = Math.max(1, Math.min(len, 3 * 1024 * 1024));
  const r = UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(id) + '?alt=media', {
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken(), Range: 'bytes=' + start + '-' + (start + len - 1) },
    muteHttpExceptions: true
  });
  const code = r.getResponseCode();
  if (code === 416) return '';  // asked past the end of the file
  if (code !== 200 && code !== 206) return 'ERR drive ' + code;
  return Utilities.base64Encode(r.getContent());
}

// The box checks in: battery, firmware version, and figures it has seen.
function report_(req) {
  return change_(function (lib) {
    const b = lib.box;
    b.lastSeen = Date.now();
    if (req.battery !== undefined) b.battery = Number(req.battery);
    if (req.fw) b.fw = String(req.fw).slice(0, 20);
    if (req.sync) b.sync = String(req.sync).slice(0, 200);
    (req.seen || []).slice(0, 50).forEach(function (uid) {
      try { b.seen[cleanUid_(uid)] = Date.now(); } catch (err) {}
    });
    return { ok: true };
  });
}
