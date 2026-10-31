// Run: node tests/insights.test.js  — ranking of feedback themes + donate defaults + HTTP wiring (offline).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildInsights, applyAiWording, norm } from '../lib/insights.js';
import { createSettings, DEFAULT_DONATE } from '../lib/settings.js';

let n = 0; const ok = (m, c) => { assert.ok(c, m); n++; };
let seq = 0;
const row = (message, o = {}) => ({ id: 'FB' + ++seq, event: 'feedback', app_id: 'snake', version: '1.0', type: 'improvement', rating: 0, message, anonymous_id: o.u || 'u' + seq, status: 'NEW', created_at: new Date(Date.UTC(2026, 9, 1, 0, seq)).toISOString(), ...o });

ok('norm strips Vietnamese accents', norm('Không chạy được, đăng nhập lỗi') === 'khong chay duoc dang nhap loi');

const rows = [
  // 4 crash reports (4 users) + 1 login bug -> crash must outrank login
  row('App bị sập khi mở', { type: 'bug', u: 'a' }), row('Game crash liên tục', { type: 'bug', u: 'b' }), row('treo máy khi chơi', { type: 'bug', u: 'c' }), row('sập luôn', { type: 'bug', u: 'd' }),
  row('Không đăng nhập được', { type: 'bug', u: 'e' }),
  // ideas: dark mode x3, sound x2, one-off
  row('Nên có dark mode', { type: 'idea', u: 'f' }), row('Thêm chế độ tối đi', { type: 'idea', u: 'g' }), row('muốn có dark mode', { type: 'idea', u: 'h' }),
  row('Thêm âm thanh nhạc nền', { type: 'idea', u: 'i' }), row('Cần nhạc nền', { type: 'idea', u: 'j' }),
  row('Thêm bảng xếp hạng bạn bè online', { type: 'idea', u: 'k' }),
  // praise + payment + closed + empty must NOT become items
  row('Game hay tuyệt vời', { type: 'review', rating: 5 }), row('paid via pi', { type: 'payment' }), row('đã sửa rồi', { type: 'bug', status: 'DONE' }), row('  ', { type: 'bug' }),
  // other app
  row('Crash ở app khác', { type: 'bug', app_id: 'other' }),
  // low-rating review -> counts as a fix
  row('Chậm và giật lag', { type: 'review', rating: 1, u: 'z' }),
];
const rep = buildInsights(rows, { app_id: 'snake' });
ok('only this app, no closed/empty/payment/praise as items', rep.totals.analyzed === 13);
ok('praise counted separately', rep.totals.praise === 1);
ok('closed skipped', rep.totals.closed_skipped === 1);
ok('fixes ranked by number of requests, crash first', rep.fixes[0].theme === 'crash' && rep.fixes[0].count === 4 && rep.fixes[0].users === 4);
ok('fix counts are non-increasing', rep.fixes.every((x, i, a) => !i || a[i - 1].count >= x.count));
ok('upgrade counts are non-increasing', rep.upgrades.every((x, i, a) => !i || a[i - 1].count >= x.count));
ok('dark mode (3) ranks above sound (2) above one-off (1)', rep.upgrades[0].theme === 'theme' && rep.upgrades[0].count === 3 && rep.upgrades[1].theme === 'sound' && rep.upgrades[1].count === 2 && rep.upgrades[2].count === 1);
ok('combined ranking is by count across fixes+upgrades', rep.ranked.every((x, i, a) => !i || a[i - 1].count >= x.count));
ok('ranks are 1..n in each list', rep.fixes.map((x) => x.rank).join() === rep.fixes.map((_, i) => i + 1).join());
ok('low-rating review became a fix (slow)', rep.fixes.some((x) => x.theme === 'slow'));
ok('crash with 4 requests is P0', rep.fixes[0].priority === 'P0');
ok('sample messages + feedback ids kept for traceability', rep.fixes[0].samples.length === 3 && rep.fixes[0].feedback_ids.length === 4);
ok('builder prompt lists top fix first', /1\. \[P0\] App bị sập.*4 phản hồi/.test(rep.builder_prompt));
ok('all apps scope includes other app', buildInsights(rows).fixes.some((x) => x.apps.includes('other')));
ok('include_closed brings back DONE rows', buildInsights(rows, { app_id: 'snake', includeClosed: true }).totals.analyzed === rep.totals.analyzed + 1);
ok('empty input is safe', buildInsights([]).ranked.length === 0 && buildInsights(null).totals.analyzed === 0);

// free-text rows with no theme still group by similarity
const free = buildInsights([row('Thêm bảng xếp hạng bạn bè', { type: 'idea' }), row('muốn bảng xếp hạng bạn bè online', { type: 'idea' }), row('Thêm skin con rắn', { type: 'idea' })]);
ok('similar free-text ideas are merged, others stay apart', free.upgrades[0].count === 2 && free.upgrades.length === 2);

// AI can only re-word: order, counts, ids stay
const before = rep.ranked.map((x) => x.id + ':' + x.count).join();
const ai = applyAiWording(rep, [{ id: rep.fixes[0].id, title: 'Sập khi mở', summary: 'x', suggested_action: 'y' }, { id: rep.upgrades[2].id, title: 'Z' }, { id: 'nope', title: 'ignored' }, { id: rep.fixes[1].id, title: 123 }]);
ok('AI wording applied', ai.fixes[0].title === 'Sập khi mở' && ai.fixes[0].summary === 'x' && ai.classifier === 'kernel');
ok('AI cannot change order or counts', ai.ranked.map((x) => x.id + ':' + x.count).join() === before && ai.fixes.map((x) => x.rank).join() === rep.fixes.map((x) => x.rank).join());
ok('bad AI payload ignored', applyAiWording(rep, 'junk') === rep && ai.fixes[1].title === rep.fixes[1].title);

// donate defaults
ok('built-in donate info', DEFAULT_DONATE.pi_wallet === 'GAQAZ5XLWREKQYMMN247A44PNPLAKRORZOPZNVG3CDPCSSFMEVFIYJJL' && DEFAULT_DONATE.mb_account === '0905428801' && DEFAULT_DONATE.mb_name === 'Tran Huu Nghi' && DEFAULT_DONATE.mb_bank === 'MB Bank');
ok('Pi address is a 56-char G... address', /^G[A-Z2-7]{55}$/.test(DEFAULT_DONATE.pi_wallet));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shfh-'));
let s = createSettings(dir, {});
ok('fresh install has donate info', s.publicDonate().pi_wallet === DEFAULT_DONATE.pi_wallet && s.publicDonate().mb_account === '0905428801');
fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ donate: { pi_wallet: '', mb_bank: '', mb_account: '', mb_name: '' } }));
s = createSettings(dir, {});
ok('old settings.json with EMPTY donate fields falls back to the defaults', s.publicDonate().pi_wallet === DEFAULT_DONATE.pi_wallet && s.publicDonate().mb_name === 'Tran Huu Nghi');
s.update({ donate: { mb_account: '111222' } });
ok('admin override wins', s.publicDonate().mb_account === '111222' && s.publicDonate().pi_wallet === DEFAULT_DONATE.pi_wallet);
s.update({ donate: { mb_account: '' } });
ok('clearing a field restores the default', s.publicDonate().mb_account === '0905428801');
ok('env override wins over default', createSettings(fs.mkdtempSync(path.join(os.tmpdir(), 'shfh-')), { PI_WALLET: 'GENV' }).publicDonate().pi_wallet === 'GENV');
console.log('insights+donate: ' + n + ' checks passed');
