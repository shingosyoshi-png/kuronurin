/*
 * ファイル名の一括変更（リネーム）ロジック。
 * buildPlan で「変更後の名前」を作り、applyPlan で実際にディスク上のファイル名を変える。
 * 実行前に必ずプランを画面で確認できるようにするため、計画と実行を分けている。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { sanitizeFileName } = require('../shared/pdf-ops.js');

const DEFAULT_RULES = {
  find: '',
  replace: '',
  useRegex: false,
  caseSensitive: false,
  template: '{base}',
  start: 1,
  step: 1,
  digits: 3,
  extCase: 'keep',
  dateSource: 'now',
};

function pad(num, digits) {
  const s = String(Math.abs(num));
  const sign = num < 0 ? '-' : '';
  return sign + (s.length >= digits ? s : '0'.repeat(digits - s.length) + s);
}

function dateParts(date) {
  return {
    yyyy: String(date.getFullYear()),
    mm: pad(date.getMonth() + 1, 2),
    dd: pad(date.getDate(), 2),
    hh: pad(date.getHours(), 2),
    mi: pad(date.getMinutes(), 2),
    ss: pad(date.getSeconds(), 2),
  };
}

function applyFindReplace(value, rules) {
  if (!rules.find) return value;
  if (rules.useRegex) {
    const flags = rules.caseSensitive ? 'g' : 'gi';
    let re;
    try {
      re = new RegExp(rules.find, flags);
    } catch (err) {
      throw new Error('正規表現が不正です: ' + err.message);
    }
    return value.replace(re, rules.replace || '');
  }
  const flags = rules.caseSensitive ? 'g' : 'gi';
  const escaped = rules.find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return value.replace(new RegExp(escaped, flags), rules.replace || '');
}

function expandTemplate(template, ctx) {
  return template.replace(/\{(\w+)\}/g, (match, token) => {
    const key = token.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(ctx, key)) return String(ctx[key]);
    return match;
  });
}

/**
 * リネーム計画を作る。ディスクは一切変更しない。
 * @param {{path:string, mtimeMs?:number}[]} files
 * @param {object} userRules
 * @param {{exists?:(p:string)=>boolean, now?:Date}} [deps]
 * @returns {{entries:Array, hasBlocking:boolean, changedCount:number}}
 */
function buildPlan(files, userRules, deps) {
  const rules = Object.assign({}, DEFAULT_RULES, userRules || {});
  const exists = (deps && deps.exists) || ((p) => fs.existsSync(p));
  const now = (deps && deps.now) || new Date();

  const sourceSet = new Set(files.map((f) => path.resolve(f.path)));
  const targetCount = new Map();
  const entries = [];

  let counter = Number(rules.start);
  if (!Number.isFinite(counter)) counter = 1;
  const step = Number(rules.step) || 1;
  const digits = Math.max(1, Math.min(10, Number(rules.digits) || 1));

  files.forEach((file, index) => {
    const abs = path.resolve(file.path);
    const dir = path.dirname(abs);
    const original = path.basename(abs);
    const ext = path.extname(original);
    const origBase = ext ? original.slice(0, -ext.length) : original;

    const entry = {
      index,
      dir,
      from: abs,
      fromName: original,
      to: abs,
      toName: original,
      status: 'unchanged',
      message: '',
    };

    try {
      const replaced = applyFindReplace(origBase, rules);
      const stamp = dateParts(
        rules.dateSource === 'mtime' && file.mtimeMs ? new Date(file.mtimeMs) : now
      );
      let extOut = ext;
      if (rules.extCase === 'lower') extOut = ext.toLowerCase();
      else if (rules.extCase === 'upper') extOut = ext.toUpperCase();

      const ctx = Object.assign(
        {
          base: replaced,
          orig: origBase,
          ext: extOut.replace(/^\./, ''),
          n: pad(counter, digits),
          i: String(index + 1),
          parent: path.basename(dir),
          date: stamp.yyyy + stamp.mm + stamp.dd,
          time: stamp.hh + stamp.mi + stamp.ss,
        },
        stamp
      );

      const templated = expandTemplate(rules.template || '{base}', ctx);
      const safeBase = sanitizeFileName(templated, origBase);
      const toName = safeBase + extOut;
      entry.toName = toName;
      entry.to = path.join(dir, toName);

      if (entry.to === entry.from) {
        entry.status = 'unchanged';
      } else if (exists(entry.to) && !sourceSet.has(entry.to)) {
        entry.status = 'exists';
        entry.message = '同名のファイルが既にあります';
      } else {
        entry.status = 'ok';
      }
    } catch (err) {
      entry.status = 'error';
      entry.message = err.message;
    }

    counter += step;
    targetCount.set(entry.to, (targetCount.get(entry.to) || 0) + 1);
    entries.push(entry);
  });

  entries.forEach((entry) => {
    if (entry.status === 'error') return;
    if (targetCount.get(entry.to) > 1) {
      entry.status = 'conflict';
      entry.message = '変更後の名前が重複しています';
    }
  });

  const hasBlocking = entries.some(
    (e) => e.status === 'conflict' || e.status === 'exists' || e.status === 'error'
  );
  const changedCount = entries.filter((e) => e.status === 'ok').length;
  return { entries, hasBlocking, changedCount };
}

/**
 * 計画を実際に適用する。入れ替え（A→B, B→A）にも耐えるよう2段階でリネームする。
 * @returns {{renamed:number, results:Array, undo:Array}}
 */
async function applyPlan(entries) {
  const targets = entries.filter((e) => e.status === 'ok');
  if (!targets.length) return { renamed: 0, results: [], undo: [] };

  const temps = [];
  const results = [];
  const undo = [];

  try {
    for (let i = 0; i < targets.length; i++) {
      const entry = targets[i];
      const tmp = path.join(
        entry.dir,
        '.kuronurin-rename-' + process.pid + '-' + i + path.extname(entry.fromName)
      );
      await fs.promises.rename(entry.from, tmp);
      temps.push({ entry, tmp });
    }
    for (const { entry, tmp } of temps) {
      await fs.promises.rename(tmp, entry.to);
      results.push({ from: entry.from, to: entry.to });
      undo.push({ from: entry.to, to: entry.from });
    }
  } catch (err) {
    // 途中で失敗したら、動かしたぶんを元に戻す
    for (const done of results.reverse()) {
      try {
        await fs.promises.rename(done.to, done.from);
      } catch (_) {
        /* 戻せないものはそのまま（メッセージで通知する） */
      }
    }
    for (const { entry, tmp } of temps) {
      if (fs.existsSync(tmp)) {
        try {
          await fs.promises.rename(tmp, entry.from);
        } catch (_) {
          /* 同上 */
        }
      }
    }
    throw new Error('リネームに失敗したため元に戻しました: ' + err.message);
  }

  return { renamed: results.length, results, undo };
}

/** applyPlan が返した undo リストで元の名前に戻す */
async function undoRename(undoList) {
  let restored = 0;
  for (const item of undoList.slice().reverse()) {
    if (!fs.existsSync(item.from)) continue;
    await fs.promises.rename(item.from, item.to);
    restored += 1;
  }
  return restored;
}

module.exports = { buildPlan, applyPlan, undoRename, DEFAULT_RULES };
