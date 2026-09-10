'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildPlan, applyPlan, undoRename } = require('../src/main/rename.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kuronurin-rename-'));
}

function files(dir, names) {
  return names.map((name) => {
    const full = path.join(dir, name);
    fs.writeFileSync(full, name);
    return { path: full };
  });
}

test('連番テンプレートで名前を作れる', () => {
  const dir = tmpDir();
  const list = files(dir, ['a.pdf', 'b.pdf', 'c.pdf']);
  const plan = buildPlan(list, {
    template: '登記申請_{n}',
    start: 1,
    step: 1,
    digits: 3,
  });
  assert.deepStrictEqual(
    plan.entries.map((e) => e.toName),
    ['登記申請_001.pdf', '登記申請_002.pdf', '登記申請_003.pdf']
  );
  assert.strictEqual(plan.hasBlocking, false);
  assert.strictEqual(plan.changedCount, 3);
});

test('日付トークンを差し込める', () => {
  const dir = tmpDir();
  const list = files(dir, ['遺産分割協議書.pdf']);
  const plan = buildPlan(
    list,
    { template: '{yyyy}{mm}{dd}_{base}' },
    { now: new Date(2026, 8, 10) }
  );
  assert.strictEqual(plan.entries[0].toName, '20260910_遺産分割協議書.pdf');
});

test('文字列置換と正規表現置換ができる', () => {
  const dir = tmpDir();
  const list = files(dir, ['scan001_控.pdf', 'scan002_控.pdf']);

  const plain = buildPlan(list, { find: 'scan', replace: '原本' });
  assert.strictEqual(plain.entries[0].toName, '原本001_控.pdf');

  const regex = buildPlan(list, {
    find: '^scan(\\d+)_(.+)$',
    replace: '$2_$1',
    useRegex: true,
  });
  assert.strictEqual(regex.entries[0].toName, '控_001.pdf');
});

test('壊れた正規表現はエラー行として返る', () => {
  const dir = tmpDir();
  const list = files(dir, ['a.pdf']);
  const plan = buildPlan(list, { find: '([', replace: '', useRegex: true });
  assert.strictEqual(plan.entries[0].status, 'error');
  assert.strictEqual(plan.hasBlocking, true);
});

test('変更後の名前が重複したら実行前に検出する', () => {
  const dir = tmpDir();
  const list = files(dir, ['a.pdf', 'b.pdf']);
  const plan = buildPlan(list, { template: '同じ名前' });
  assert.ok(plan.entries.every((e) => e.status === 'conflict'));
  assert.strictEqual(plan.hasBlocking, true);
});

test('既存ファイルとぶつかる場合も検出する', () => {
  const dir = tmpDir();
  const list = files(dir, ['a.pdf']);
  fs.writeFileSync(path.join(dir, 'b.pdf'), 'existing');
  const plan = buildPlan(list, { template: 'b' });
  assert.strictEqual(plan.entries[0].status, 'exists');
});

test('拡張子の大文字小文字を揃えられる', () => {
  const dir = tmpDir();
  const list = files(dir, ['a.PDF']);
  const plan = buildPlan(list, { template: '{base}', extCase: 'lower' });
  assert.strictEqual(plan.entries[0].toName, 'a.pdf');
});

test('実際にリネームして元に戻せる', async () => {
  const dir = tmpDir();
  const list = files(dir, ['a.pdf', 'b.pdf']);
  const plan = buildPlan(list, { template: '案件_{n}', digits: 2 });
  const result = await applyPlan(plan.entries);

  assert.strictEqual(result.renamed, 2);
  assert.ok(fs.existsSync(path.join(dir, '案件_01.pdf')));
  assert.ok(fs.existsSync(path.join(dir, '案件_02.pdf')));
  assert.ok(!fs.existsSync(path.join(dir, 'a.pdf')));

  const restored = await undoRename(result.undo);
  assert.strictEqual(restored, 2);
  assert.ok(fs.existsSync(path.join(dir, 'a.pdf')));
  assert.ok(fs.existsSync(path.join(dir, 'b.pdf')));
});

test('名前の入れ替え（A→B, B→A）もできる', async () => {
  const dir = tmpDir();
  const list = files(dir, ['a.pdf', 'b.pdf']);
  const entries = [
    { index: 0, dir, from: list[0].path, fromName: 'a.pdf', to: list[1].path, toName: 'b.pdf', status: 'ok' },
    { index: 1, dir, from: list[1].path, fromName: 'b.pdf', to: list[0].path, toName: 'a.pdf', status: 'ok' },
  ];
  const result = await applyPlan(entries);
  assert.strictEqual(result.renamed, 2);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'a.pdf'), 'utf8'), 'b.pdf');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'b.pdf'), 'utf8'), 'a.pdf');
});

test('使えない文字は自動で置き換える', () => {
  const dir = tmpDir();
  const list = files(dir, ['a.pdf']);
  const plan = buildPlan(list, { template: '甲/乙:丙' });
  assert.strictEqual(plan.entries[0].toName, '甲_乙_丙.pdf');
});
