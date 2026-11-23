import { createHash } from 'node:crypto';

export const FAMILY_COUNTS = Object.freeze({
  'no-skill': 3, explicit: 2, implicit: 3, ambiguity: 2, equivalent: 1,
  references: 2, 'scripts-assets': 2, complementary: 2, continuation: 2, 'task-switch': 1,
});

export const JOURNEYS = Object.freeze([
  ['no-skill-01', 'no-skill', '已有明细的金额汇总'],
  ['no-skill-02', 'no-skill', '已有状态的数量汇总'],
  ['no-skill-03', 'no-skill', '缺少公司政策时保留判断'],
  ['explicit-01', 'explicit', '指定退货政策'],
  ['explicit-02', 'explicit', '指定发布检查表'],
  ['implicit-01', 'implicit', '运输路由', true],
  ['implicit-02', 'implicit', '补货建议'],
  ['implicit-03', 'implicit', '客户合并'],
  ['ambiguity-01', 'ambiguity', '缺少配送方式'],
  ['ambiguity-02', 'ambiguity', '缺少目标币种'],
  ['equivalent-01', 'equivalent', '等价税额计算'],
  ['references-01', 'references', '分层资助政策', true],
  ['references-02', 'references', '退货例外条款'],
  ['scripts-assets-01', 'scripts-assets', '批次清单归一化'],
  ['scripts-assets-02', 'scripts-assets', '分段运费', true],
  ['complementary-01', 'complementary', '对账并去除个人信息'],
  ['complementary-02', 'complementary', '运输分类和发运简报'],
  ['continuation-01', 'continuation', '连续批次复用政策'],
  ['continuation-02', 'continuation', '政策修订后重新计算'],
  ['task-switch-01', 'task-switch', '切换到费用分组'],
].map(([id, family, title, anchor = false]) => ({ id, family, title, anchor })));

export function hashBytes(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function corpusFile(path, content, { encoding = 'utf8', mode = '100644' } = {}) {
  const bytes = Buffer.from(content, encoding);
  return { path, content, encoding, mode, bytes: bytes.length, sha256: hashBytes(bytes) };
}

function pretty(value) { return JSON.stringify(value, null, 2) + '\n'; }
function resource(path, content, options) { return corpusFile(path, content, options); }

function integer(seed, key, min, max) {
  const n = Number.parseInt(hashBytes(seed + '|' + key).slice(0, 8), 16);
  return min + (n % (max - min + 1));
}

function builder(journey, { seed, material, roundCount, materialVersion }) {
  const prefix = journey.id + '-' + material;
  const brand = (material === 'a' ? '松涛' : '橙屿') + integer(seed, 'brand', 10, 99);
  const skills = [], attachments = [], turns = [], contracts = [], events = [], clarification = [];
  const requiredCapabilities = new Set(['workspace-files']);
  function skill(suffix, description, body, files = [], { version = 'v1', requires = [] } = {}) {
    const id = prefix + '-' + suffix, name = 'bm-' + id;
    const prose = materialVersion === '2' ? body.split(/\n+/u).join('\n\n') : body;
    const main = ['---', 'name: ' + name, 'description: ' + JSON.stringify(brand + description),
      '---', '', '# ' + brand + description, '', prose, '',
      '本材料为可公开复现的合成业务资料，许可 CC0-1.0。', ...(materialVersion === '2' ? [''] : []),
      '金额一律使用整数分；若有舍入，按文中规则执行。', ''].join('\n');
    const value = { id, name, description: brand + description, requires, initial_version: version,
      versions: { [version]: { files: [resource('SKILL.md', main), ...files] } } };
    skills.push(value);
    requiredCapabilities.add('skill-content');
    if (files.length) requiredCapabilities.add('resource-read');
    return value;
  }
  function requireResources(id, alternatives) {
    contracts.push({ id, kind: 'resources', critical: true, alternatives });
  }
  function reads(s, paths = ['SKILL.md'], version = 'v1') {
    return paths.map(path => {
      const file = s.versions[version].files.find(item => item.path === path);
      return { skill_id: s.id, path, sha256: file.sha256 };
    });
  }
  function output(id, value, { rowKey = 'id', forbiddenFields = [], turnId } = {}) {
    const path = 'output/' + id + '.json';
    contracts.push({ id: 'business-' + id, kind: 'artifact-json', critical: true,
      path, comparison: Array.isArray(value) ? 'rows-by-key' : 'subset', row_key: rowKey,
      expected: value, forbidden_fields: forbiddenFields, ...(turnId ? { turn_id: turnId } : {}) });
    return path;
  }
  function input(id, value, format = 'json') {
    const path = 'input/' + id + '.' + format;
    attachments.push(resource(path, format === 'json' ? pretty(value) : value));
    return path;
  }
  function turn(prompt, paths = [], id = 'turn-' + (turns.length + 1)) {
    turns.push({ id, prompt, attachment_paths: paths });
  }
  function rowId(i, round = 1) { return 'R' + integer(seed, 'identity', 100, 999) + '-' + round + '-' + (i + 1); }
  function n(key, min, max) { return integer(seed, key, min, max); }
  function select(allowedSets = [skills.map(s => s.id)], { empty = false } = {}) {
    contracts.push({ id: 'legal-selection', kind: 'selection', critical: false,
      allowed_sets: empty ? [[]] : allowedSets });
  }
  function clarify(topic, response, expectedValue) {
    clarification.push({ topic_id: topic, max_questions: 1, response, expected_value: expectedValue });
    contracts.push({ id: 'clarify-' + topic, kind: 'clarification', critical: true, topic_id: topic,
      min: 1, max: 1, before_artifact: true });
  }
  return { prefix, brand, seed, material, roundCount, skills, attachments, turns, contracts, events,
    clarification, requiredCapabilities, skill, reads, requireResources, output, input, turn, rowId, n, select, clarify };
}

function routingSkill(b, suffix = 'routing', version = 'v1', threshold) {
  const limit = threshold ?? b.n('route-limit', 5, 12);
  const policy = { express_max_kg: limit, fragile_route: 'care', standard_route: 'standard', express_route: 'express' };
  const s = b.skill(suffix, '包裹运输路由规则', [
    '处理需要给包裹选择承运线路的请求。读取 references/routing.json。',
    '易碎件使用 fragile_route；其余重量小于或等于 express_max_kg 使用 express_route，超过使用 standard_route。',
    '输出 JSON 数组，每行保留 id，并写 route。不要用客户姓名或订单编号猜测线路。'
  ].join('\n'), [resource('references/routing.json', pretty(policy))], { version });
  return { skill: s, policy, classify: row => row.fragile ? 'care' : row.weight_kg <= limit ? 'express' : 'standard' };
}

function routingBatch(b, routing, round, wording) {
  const rows = [
    { id: b.rowId(0, round), weight_kg: routing.policy.express_max_kg - 1 + (round % 2), fragile: false },
    { id: b.rowId(1, round), weight_kg: routing.policy.express_max_kg + round, fragile: false },
    { id: b.rowId(2, round), weight_kg: 2 + round, fragile: true },
  ];
  const path = b.input('packages-' + round, rows);
  const out = b.output('routes-' + round, rows.map(row => ({ id: row.id, route: routing.classify(row) })), { turnId: 'turn-' + round });
  b.turn(wording + '。包裹资料在 ' + path + '。请把每个 id 和 route 保存为 ' + out + '。', [path]);
}

export function buildJourney(journey, { seed, material, roundCount, materialVersion = '1' }) {
  const b = builder(journey, { seed, material, roundCount, materialVersion });
  const { brand } = b;
  switch (journey.id) {
    case 'no-skill-01': {
      const rows = [1, 2, 3].map((_, i) => ({ id: b.rowId(i), quantity: b.n('qty-' + i, 2, 9), unit_price_cents: b.n('price-' + i, 101, 901) }));
      const path = b.input('invoice', rows);
      const out = b.output('invoice-total', { total_cents: rows.reduce((sum, row) => sum + row.quantity * row.unit_price_cents, 0) });
      b.turn('请把 ' + path + ' 中每行数量乘以单价后相加。全部价格已经是整数分，不需要税费或折扣，把 total_cents 保存为 ' + out + '。', [path]);
      b.select([], { empty: true });
      break;
    }
    case 'no-skill-02': {
      const rows = Array.from({ length: b.n('rows', 7, 11) }, (_, i) => ({ id: b.rowId(i), status: ['ready', 'held', 'ready', 'sent'][i % 4] }));
      const path = b.input('statuses', rows), counts = {};
      for (const row of rows) counts[row.status] = (counts[row.status] ?? 0) + 1;
      const out = b.output('status-counts', counts);
      b.turn('统计 ' + path + ' 中每种 status 的行数，不做业务判断。请保存一个以状态为键、数量为值的 JSON 对象到 ' + out + '。', [path]);
      b.select([], { empty: true });
      break;
    }
    case 'no-skill-03': {
      const path = b.input('request', { applicant: brand + '员工', amount_cents: b.n('expense', 3000, 9000), category: '跨境差旅' });
      const out = b.output('decision', { status: 'needs_information', missing: ['travel_reimbursement_policy'] });
      b.turn('请按 ' + brand + ' 公司的跨境差旅报销政策审核 ' + path + '。如果现有资料没有这家公司的政策，请不要自行设定额度，在 ' + out + ' 保存 status 为 needs_information，missing 数组写 travel_reimbursement_policy。', [path]);
      b.select([], { empty: true });
      break;
    }
    case 'explicit-01': {
      const days = b.n('days', 12, 28), limit = b.n('limit', 2000, 7000);
      const s = b.skill('refund', '退货审批政策', '按 references/refund.json 审核。未拆封且购买天数不超过 max_days 可退；金额超过 review_above_cents 则需 review，其余符合条件为 approve，不符合为 reject。输出 id 和 decision。',
        [resource('references/refund.json', pretty({ max_days: days, review_above_cents: limit }))]);
      const rows = [{ id: b.rowId(0), days: days, sealed: true, amount_cents: limit },
        { id: b.rowId(1), days: days - 1, sealed: true, amount_cents: limit + 1 },
        { id: b.rowId(2), days: days + 1, sealed: true, amount_cents: 100 },
        { id: b.rowId(3), days: 1, sealed: false, amount_cents: 100 }];
      const path = b.input('returns', rows), out = b.output('refunds', rows.map((row, i) => ({ id: row.id, decision: ['approve', 'review', 'reject', 'reject'][i] })));
      b.turn('请使用 ' + s.name + ' 审核这批退货。资料在 ' + path + '，将每行 id 和 decision 保存为 ' + out + '。', [path]);
      b.requireResources('refund-policy-read', [b.reads(s, ['SKILL.md', 'references/refund.json'])]); b.select();
      break;
    }
    case 'explicit-02': {
      const max = b.n('bugs', 1, 3), min = b.n('coverage', 80, 95);
      const s = b.skill('release', '发布放行检查表', '使用 references/checklist.json。存在 blocker 为 stop；否则 test_coverage 小于最低值或者 open_minor 超过上限为 review；其余为 ship。输出 id 和 decision。',
        [resource('references/checklist.json', pretty({ minimum_test_coverage: min, maximum_open_minor: max }))]);
      const rows = [{ id: b.rowId(0), blocker: false, test_coverage: min, open_minor: max },
        { id: b.rowId(1), blocker: true, test_coverage: 100, open_minor: 0 },
        { id: b.rowId(2), blocker: false, test_coverage: min - 1, open_minor: 0 }];
      const path = b.input('releases', rows), out = b.output('release-decisions', rows.map((r, i) => ({ id: r.id, decision: ['ship', 'stop', 'review'][i] })));
      b.turn('请按照 ' + s.name + ' 判断 ' + path + ' 中的版本能否发布。保存 id 和 decision 到 ' + out + '。', [path]);
      b.requireResources('release-checklist-read', [b.reads(s, ['SKILL.md', 'references/checklist.json'])]); b.select();
      break;
    }
    case 'implicit-01':
    case 'continuation-01': {
      const r = routingSkill(b);
      for (let round = 1; round <= roundCount; round++) routingBatch(b, r, round,
        round === 1 ? '请按 ' + brand + ' 的现行规则为今天的包裹安排运输线路' : '沿用刚才的业务规则，处理刚收到的下一批包裹');
      b.requireResources('routing-policy-read', [b.reads(r.skill, ['SKILL.md', 'references/routing.json'])]); b.select();
      break;
    }
    case 'implicit-02':
    case 'task-switch-01': {
      const target = b.n('target', 30, 70), reorder = target - b.n('gap', 10, 20);
      const s = b.skill('replenish', '库存补货规则', '读取 references/stock.json。可用库存为 on_hand 减 reserved；低于 reorder_below 时补到 target_stock，否则补货量为 0。输出 id 和 order_quantity。',
        [resource('references/stock.json', pretty({ reorder_below: reorder, target_stock: target }))]);
      const rows = [{ id: b.rowId(0), on_hand: reorder, reserved: 3 }, { id: b.rowId(1), on_hand: target, reserved: 0 }, { id: b.rowId(2), on_hand: reorder, reserved: 0 }];
      const path = b.input('inventory', rows), out = b.output('replenishment', rows.map(r => ({ id: r.id, order_quantity: r.on_hand - r.reserved < reorder ? target - r.on_hand + r.reserved : 0 })));
      b.turn('请按 ' + brand + ' 仓库的现行规则给 ' + path + ' 做补货建议，输出 id 和 order_quantity 到 ' + out + '。', [path]);
      b.requireResources('inventory-policy-read', [b.reads(s, ['SKILL.md', 'references/stock.json'])]);
      if (journey.id === 'task-switch-01') {
        const expenses = [{ id: b.rowId(0, 2), category: 'train', cents: b.n('train', 600, 1200) },
          { id: b.rowId(1, 2), category: 'meal', cents: b.n('meal', 300, 900) },
          { id: b.rowId(2, 2), category: 'train', cents: b.n('train2', 100, 500) }];
        const second = b.input('expenses', expenses), totals = {};
        for (const row of expenses) totals[row.category] = (totals[row.category] ?? 0) + row.cents;
        const secondOut = b.output('expense-groups', totals, { turnId: 'turn-2' });
        b.turn('库存工作结束。现在请处理另一件事：把 ' + second + ' 的金额按 category 相加，不做报销合规判断。保存各分类整数分总额到 ' + secondOut + '。', [second]);
      }
      b.select(); break;
    }
    case 'implicit-03': {
      const aliases = { ['North-' + b.n('north', 10, 99)]: 'north', ['South-' + b.n('south', 10, 99)]: 'south' };
      const s = b.skill('customers', '客户身份合并规则', '读取 assets/customer-aliases.json。先去除名称首尾空格，再按别名表转为 customer_key；大小写不同视为相同别名。相同 customer_key 的 cents 相加。输出 customer_key 和 total_cents，未知别名保留小写原文。',
        [resource('assets/customer-aliases.json', pretty(aliases))]);
      const keys = Object.keys(aliases), rows = [{ name: ' ' + keys[0] + ' ', cents: b.n('c1', 100, 500) },
        { name: keys[0].toLowerCase(), cents: b.n('c2', 100, 500) }, { name: keys[1], cents: b.n('c3', 100, 500) }];
      const path = b.input('customers', rows), out = b.output('customer-totals', [{ customer_key: 'north', total_cents: rows[0].cents + rows[1].cents }, { customer_key: 'south', total_cents: rows[2].cents }], { rowKey: 'customer_key' });
      b.turn('这份客户流水有同一个客户的不同写法，请按 ' + brand + ' 的客户合并口径汇总。输入是 ' + path + '，在 ' + out + ' 保存 customer_key 和 total_cents。', [path]);
      b.requireResources('customer-alias-read', [b.reads(s, ['SKILL.md', 'assets/customer-aliases.json'])]); b.select(); break;
    }
    case 'ambiguity-01': {
      const regular = b.n('regular', 200, 500), priority = regular + b.n('priority', 100, 400);
      const s = b.skill('delivery', '配送方式报价规则', '配送方式必须由用户确定，缺少时先询问，不能默认。读取 references/delivery.json 的每件整数分价格。输出 delivery_mode 和 total_cents。',
        [resource('references/delivery.json', pretty({ economy: regular, priority }))]);
      const count = b.n('count', 2, 8), path = b.input('delivery', { package_count: count });
      const out = b.output('quote', { delivery_mode: 'priority', total_cents: priority * count });
      b.turn('请按 ' + brand + ' 配送价目给 ' + path + ' 这一批报价，结果保存到 ' + out + '。所需信息不全时先问我。', [path]);
      b.clarify('delivery-mode', '这批用优先配送，delivery_mode 为 priority。', 'priority');
      b.requireResources('delivery-rate-read', [b.reads(s, ['SKILL.md', 'references/delivery.json'])]); b.select(); break;
    }
    case 'ambiguity-02': {
      const rate = b.n('rate', 6, 9);
      const s = b.skill('currency', '预算币种换算规则', '输入以 source_cents 记录。目标币种必须先向用户确认。内部固定换算表位于 references/rates.json，不使用实时汇率。USD 保持原值；CNY 乘以 cny_per_usd。输出 currency 和 total_cents。',
        [resource('references/rates.json', pretty({ cny_per_usd: rate }))]);
      const amounts = [b.n('usd1', 100, 500), b.n('usd2', 100, 500)], path = b.input('budget', amounts.map(source_cents => ({ source_cents })));
      const out = b.output('converted-budget', { currency: 'CNY', total_cents: amounts.reduce((a, c) => a + c, 0) * rate });
      b.turn('请按 ' + brand + ' 内部预算口径汇总并换算 ' + path + '，结果写到 ' + out + '。需要的信息缺失时先问我。', [path]);
      b.clarify('target-currency', '目标币种用人民币，currency 写 CNY。', 'CNY');
      b.requireResources('currency-rate-read', [b.reads(s, ['SKILL.md', 'references/rates.json'])]); b.select(); break;
    }
    case 'equivalent-01': {
      const rate = b.n('tax', 3, 9), policy = pretty({ tax_percent: rate, rounding: 'half-up-per-row' });
      const a = b.skill('tax-ledger', '按行计算税额', '读取 references/tax.json。每行税额为 net_cents 乘税率除以 100，四舍五入到整数分。输出 id、tax_cents 和 gross_cents。',
        [resource('references/tax.json', policy)]);
      const c = b.skill('tax-invoice', '发票含税金额计算', '读取 references/tax.json。逐行独立把税额四舍五入为整数分，再加 net_cents。输出 id、tax_cents 和 gross_cents。',
        [resource('references/tax.json', policy)]);
      const rows = [0, 1, 2].map(i => ({ id: b.rowId(i), net_cents: b.n('net-' + i, 101, 899) }));
      const path = b.input('invoice-lines', rows), out = b.output('tax-lines', rows.map(r => ({ id: r.id, tax_cents: Math.round(r.net_cents * rate / 100), gross_cents: r.net_cents + Math.round(r.net_cents * rate / 100) })));
      b.turn('按 ' + brand + ' 的逐行税额口径给 ' + path + ' 补齐 tax_cents 和 gross_cents，保留 id，写到 ' + out + '。使用能完成这项工作的任一现行规则即可。', [path]);
      b.requireResources('tax-source-read', [b.reads(a, ['SKILL.md', 'references/tax.json']), b.reads(c, ['SKILL.md', 'references/tax.json'])]);
      b.select([[a.id], [c.id], [a.id, c.id]]); break;
    }
    case 'references-01': {
      const min = b.n('age', 18, 25), region = 'Z' + b.n('region', 10, 99), cap = b.n('cap', 1000, 3000);
      const s = b.skill('grant', '区域资助资格政策', '先读 references/eligibility.md，再按它引用的区域表和补助上限判断。输出 id、eligible 和 grant_cents。不要把目录描述当成完整政策。',
        [resource('references/eligibility.md', '申请人 age 必须达到 ' + min + '；region 必须在 tables/regions.json；grant_cents 取请求金额与 tables/caps.json 的上限较小值。不符合资格为 0。\n'),
          resource('references/tables/regions.json', pretty([region])), resource('references/tables/caps.json', pretty({ maximum_cents: cap }))]);
      for (let round = 1; round <= roundCount; round++) {
        const rows = [{ id: b.rowId(0, round), age: min, region, requested_cents: cap + 100 * round },
          { id: b.rowId(1, round), age: min - 1, region, requested_cents: 100 }, { id: b.rowId(2, round), age: min + 1, region: 'OUTSIDE', requested_cents: 100 }];
        const path = b.input('applications-' + round, rows), out = b.output('grants-' + round, rows.map((r, i) => ({ id: r.id, eligible: i === 0, grant_cents: i === 0 ? cap : 0 })));
        b.turn((round === 1 ? '请审核 ' : '按同一现行政策继续审核 ') + brand + ' 的资助申请 ' + path + '，保存 id、eligible、grant_cents 到 ' + out + '。', [path]);
      }
      b.requireResources('grant-chain-read', [b.reads(s, ['SKILL.md', 'references/eligibility.md', 'references/tables/regions.json', 'references/tables/caps.json'])]); b.select(); break;
    }
    case 'references-02': {
      const days = b.n('return-days', 10, 20), exception = 'CUSTOM-' + b.n('custom', 10, 99);
      const s = b.skill('return-exceptions', '退货期限与例外', '常规期限在 references/returns.md，例外类别在它引用的表中；例外规则优先。输出 id、decision 和 clause。',
        [resource('references/returns.md', '购买后不超过 ' + days + ' 天允许退货，clause 为 WINDOW；超过为 reject，clause 为 LATE。必须再检查 exceptions/categories.json，例外类别永远 reject，clause 为 CUSTOM。\n'),
          resource('references/exceptions/categories.json', pretty([exception]))]);
      const rows = [{ id: b.rowId(0), days, category: 'STANDARD' }, { id: b.rowId(1), days: 1, category: exception }, { id: b.rowId(2), days: days + 1, category: 'STANDARD' }];
      const path = b.input('return-requests', rows), out = b.output('return-results', rows.map((r, i) => ({ id: r.id, decision: i === 0 ? 'approve' : 'reject', clause: ['WINDOW', 'CUSTOM', 'LATE'][i] })));
      b.turn('请按 ' + brand + ' 的完整退货政策审核 ' + path + '，特别留意例外类别。保存 id、decision 和 clause 到 ' + out + '。', [path]);
      b.requireResources('return-chain-read', [b.reads(s, ['SKILL.md', 'references/returns.md', 'references/exceptions/categories.json'])]); b.select(); break;
    }
    case 'scripts-assets-01': {
      const map = { ['north-' + b.n('n', 10, 99)]: 'N', ['south-' + b.n('s', 10, 99)]: 'S' };
      const markerBytes = Buffer.from([0, 255, 10, 13, 42, b.n('byte', 1, 254)]);
      const script = [
        '#!/usr/bin/env node', "import { readFileSync, writeFileSync } from 'node:fs';",
        "const rows = readFileSync(process.argv[2], 'utf8').trim().split(/\\r?\\n/).slice(1);",
        "const aliases = JSON.parse(readFileSync(new URL('../assets/depots.json', import.meta.url), 'utf8'));",
        "const marker = readFileSync(new URL('../assets/format-marker.bin', import.meta.url)).toString('hex');",
        "const result = rows.map(line => { const [id, depot, count] = line.split(','); return { id: id.trim(), depot: aliases[depot.trim().toLowerCase()], count: Number(count), format_marker_hex: marker }; });",
        "writeFileSync(process.argv[3], JSON.stringify(result, null, 2) + '\\n');", ''
      ].join('\n');
      const s = b.skill('manifest', '仓库批次清单整理', '清单是简单三列 CSV，没有逗号转义。去掉单元格首尾空格，把 depot 按 assets/depots.json 转为代码，count 转为整数。scripts/normalize.mjs 可执行同样转换，输入和输出路径分别为两个参数。可执行脚本，也可按相同规则处理。每行必须附上 assets/format-marker.bin 字节的小写十六进制值作为 format_marker_hex。输出 id、depot、count、format_marker_hex。',
        [resource('assets/depots.json', pretty(map)), resource('scripts/normalize.mjs', script, { mode: '100755' }),
          resource('assets/format-marker.bin', markerBytes.toString('base64'), { encoding: 'base64' }),
          resource('assets/empty.txt', '')]);
      const keys = Object.keys(map), rows = [{ id: b.rowId(0), depot: 'N', count: b.n('ct', 2, 9) }, { id: b.rowId(1), depot: 'S', count: b.n('ct2', 2, 9) }];
      const csv = 'id,depot,count\r\n ' + rows[0].id + ' , ' + keys[0].toUpperCase() + ' , ' + rows[0].count + '\r\n' + rows[1].id + ',' + keys[1] + ',' + rows[1].count + '\r\n';
      const path = b.input('manifest', csv, 'csv'), out = b.output('manifest-clean', rows.map(row => ({ ...row, format_marker_hex: markerBytes.toString('hex') })));
      b.turn('请把 ' + path + ' 整理成 ' + brand + ' 仓库使用的标准批次清单，保留 id、depot、count 并附导入格式标识 format_marker_hex，保存到 ' + out + '。', [path]);
      b.requireResources('manifest-data-read', [b.reads(s, ['SKILL.md', 'assets/depots.json', 'assets/format-marker.bin'])]); b.select(); break;
    }
    case 'scripts-assets-02': {
      const base = b.n('base', 100, 400), per = b.n('per', 50, 150), included = b.n('included', 2, 5);
      const policy = { base_cents: base, included_kg: included, per_extra_kg_cents: per };
      const script = ['#!/usr/bin/env node', "import { readFileSync, writeFileSync } from 'node:fs';",
        "const policy = JSON.parse(readFileSync(new URL('../assets/tariff.json', import.meta.url), 'utf8'));",
        "const rows = JSON.parse(readFileSync(process.argv[2], 'utf8'));",
        "const result = rows.map(row => ({ id: row.id, fee_cents: policy.base_cents + Math.max(0, Math.ceil(row.weight_kg - policy.included_kg)) * policy.per_extra_kg_cents }));",
        "writeFileSync(process.argv[3], JSON.stringify(result, null, 2) + '\\n');", ''].join('\n');
      const s = b.skill('tariff', '包裹分段运费计算', '运费表在 assets/tariff.json。先收 base_cents，超过 included_kg 的部分每开始一公斤收 per_extra_kg_cents，不足一公斤向上取整。scripts/quote.mjs 的两个参数分别是输入 JSON 路径和输出路径。也可直接按公式计算。输出 id 和 fee_cents。',
        [resource('assets/tariff.json', pretty(policy)), resource('scripts/quote.mjs', script, { mode: '100755' })]);
      for (let round = 1; round <= roundCount; round++) {
        const rows = [{ id: b.rowId(0, round), weight_kg: included }, { id: b.rowId(1, round), weight_kg: included + 0.5 * round }, { id: b.rowId(2, round), weight_kg: 0.5 }];
        const path = b.input('weights-' + round, rows), out = b.output('fees-' + round, rows.map(r => ({ id: r.id, fee_cents: base + Math.max(0, Math.ceil(r.weight_kg - included)) * per })));
        b.turn((round === 1 ? '请计算 ' : '按相同价目继续计算 ') + brand + ' 的包裹运费，输入在 ' + path + '，保存 id 和 fee_cents 到 ' + out + '。', [path]);
      }
      b.requireResources('tariff-data-read', [b.reads(s, ['SKILL.md', 'assets/tariff.json'])]); b.select(); break;
    }
    case 'complementary-01': {
      const tolerance = b.n('tolerance', 1, 9);
      const a = b.skill('reconcile', '交易金额对账', '读取 references/reconcile.json。实际 paid_cents 与 expected_cents 的差绝对值不超过 tolerance_cents 为 matched，否则为 mismatch。保留 id、status 和 delta_cents。',
        [resource('references/reconcile.json', pretty({ tolerance_cents: tolerance }))]);
      const c = b.skill('privacy', '外发报表个人信息处理', '外发报表只允许保留 id、status、delta_cents，禁止输出 email、phone、customer_name。这些字段必须完全删除，不能用原值、掩码或哈希代替。', [], { requires: [a.id] });
      const rows = [{ id: b.rowId(0), expected_cents: 1000, paid_cents: 1000 + tolerance, email: 'synthetic-a@example.invalid', phone: '000000001', customer_name: brand + '甲' },
        { id: b.rowId(1), expected_cents: 2000, paid_cents: 2000 - tolerance - 1, email: 'synthetic-b@example.invalid', phone: '000000002', customer_name: brand + '乙' }];
      const path = b.input('transactions', rows), out = b.output('external-reconciliation', rows.map(r => ({ id: r.id, status: Math.abs(r.paid_cents - r.expected_cents) <= tolerance ? 'matched' : 'mismatch', delta_cents: r.paid_cents - r.expected_cents })), { forbiddenFields: ['email', 'phone', 'customer_name'] });
      b.turn('请按 ' + brand + ' 的金额容差对账 ' + path + '，再按外发报表政策处理个人信息，交付给外部合作方。保存最终 JSON 到 ' + out + '。', [path]);
      b.requireResources('reconcile-and-privacy-read', [[...b.reads(a, ['SKILL.md', 'references/reconcile.json']), ...b.reads(c)]]); b.select(); break;
    }
    case 'complementary-02': {
      const r = routingSkill(b), code = 'SHIFT-' + b.n('shift', 10, 99);
      const s = b.skill('dispatch', '发运简报编制', '把已确定的 route 按类别汇总。读取 assets/shift.json，输出 shift 和 counts。counts 必须包含 care、express、standard 的整数数量，零也保留。',
        [resource('assets/shift.json', pretty({ shift: code }))], { requires: [r.skill.id] });
      const rows = [{ id: b.rowId(0), weight_kg: 1, fragile: true }, { id: b.rowId(1), weight_kg: 1, fragile: false }, { id: b.rowId(2), weight_kg: r.policy.express_max_kg + 1, fragile: false }];
      const path = b.input('dispatch-packages', rows), out = b.output('dispatch-brief', { shift: code, counts: { care: 1, express: 1, standard: 1 } });
      b.turn('请先按 ' + brand + ' 的线路规则分类 ' + path + '，再按当班简报口径生成 counts 和 shift，保存到 ' + out + '。', [path]);
      b.requireResources('routing-and-brief-read', [[...b.reads(r.skill, ['SKILL.md', 'references/routing.json']), ...b.reads(s, ['SKILL.md', 'assets/shift.json'])]]); b.select(); break;
    }
    case 'continuation-02': {
      const r = routingSkill(b), oldLimit = r.policy.express_max_kg;
      routingBatch(b, r, 1, '请按 ' + brand + ' 当前规则安排第一批包裹');
      const newPolicy = { ...r.policy, express_max_kg: oldLimit + 3 };
      const v1 = r.skill.versions.v1.files;
      r.skill.versions.v2 = { files: v1.map(file => file.path === 'references/routing.json' ? resource(file.path, pretty(newPolicy)) : file) };
      b.events.push({ id: 'policy-v2', before_turn: 'turn-2', kind: 'publish-version', skill_id: r.skill.id, version: 'v2' });
      const rows = [{ id: b.rowId(0, 2), weight_kg: oldLimit + 1, fragile: false }, { id: b.rowId(1, 2), weight_kg: oldLimit + 4, fragile: false }];
      const path = b.input('packages-2', rows), out = b.output('routes-2', rows.map((row, i) => ({ id: row.id, route: i === 0 ? 'express' : 'standard' })), { turnId: 'turn-2' });
      b.turn('运输部门刚发布了新版规则。请按最新版本处理 ' + path + '，把 id 和 route 保存为 ' + out + '。', [path]);
      b.requireResources('routing-v1-read', [b.reads(r.skill, ['SKILL.md', 'references/routing.json'])]);
      b.requireResources('routing-v2-read', [b.reads(r.skill, ['references/routing.json'], 'v2')]);
      b.contracts.push({ id: 'revision-published', kind: 'state-event', critical: true, event_id: 'policy-v2', expected_status: 'applied' });
      b.select(); break;
    }
    default: throw new Error('Unknown journey ' + journey.id);
  }
  return {
    skills: b.skills, attachments: b.attachments, turns: b.turns, contracts: b.contracts,
    events: b.events, clarification: b.clarification, required_capabilities: [...b.requiredCapabilities],
  };
}

export function createDistractor({ caseId, seed, index, materialVersion = '1' }) {
  const subjects = ['盆栽浇水记录', '会议座位编排', '图书馆借阅标签', '摄影文件命名', '运动器材盘点', '菜园采收日志', '展厅灯光巡检', '纸张尺寸换算'];
  const name = 'bm-' + caseId + '-catalog-' + String(index).padStart(3, '0');
  const subject = subjects[index % subjects.length], marker = integer(seed, 'distractor-' + index, 1000, 9999);
  const body = ['---', 'name: ' + name, 'description: ' + JSON.stringify('仅处理' + subject + '，不提供交易、运输或人事政策。'),
    '---', '', '# ' + subject, '', '仅当用户要求' + subject + '时使用。登记编号为 ' + marker + '，按原始时间先后排序，保留来源。',
    ...(materialVersion === '2' ? [''] : []),
    '本材料不包含其他公司的业务规则，不能用于推断其他任务的政策。', ...(materialVersion === '2' ? [''] : []),
    '许可 CC0-1.0。', ''].join('\n');
  return { id: name.slice(3), name, description: '仅处理' + subject, requires: [], initial_version: 'v1',
    versions: { v1: { files: [resource('SKILL.md', body)] } } };
}
