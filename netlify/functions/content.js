// netlify/functions/content.js
// GET /api/content
// 首次被请求时自动：建表 → 表为空则写入初始数据 → 查询业务数据返回
// 任何数据库异常 → 500，前端自动 fallback 到 /data.json
//
// 说明：
// 1) SQL 全部以字符串常量写在本文件顶部，不读取任何外部文件；
// 2) DDL / Seed 均为「一条语句一个字符串」，逐条执行，兼容不支持多语句的驱动；
// 3) 初始化具备幂等性：查空表 + INSERT ... ON CONFLICT DO NOTHING 双保险。

"use strict";

const { getDatabase } = require("@netlify/database");

/* =========================================================
   1) 建表 DDL（等价于 schema.sql）
   ========================================================= */
const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS scam_samples (
     id BIGSERIAL PRIMARY KEY,
     content      TEXT    NOT NULL,
     is_active    BOOLEAN DEFAULT TRUE,
     show_in_ticker BOOLEAN DEFAULT TRUE,
     sort_order   INT     DEFAULT 0,
     created_at   TIMESTAMPTZ DEFAULT now()
   );`,

  `CREATE TABLE IF NOT EXISTS scam_reports (
     id BIGSERIAL PRIMARY KEY,
     category   TEXT NOT NULL,
     content    TEXT NOT NULL,
     is_active  BOOLEAN DEFAULT TRUE,
     sort_order INT   DEFAULT 0,
     created_at TIMESTAMPTZ DEFAULT now()
   );`,

  `CREATE TABLE IF NOT EXISTS quiz_questions (
     id BIGSERIAL PRIMARY KEY,
     tag          TEXT  NOT NULL,
     script       JSONB DEFAULT '[]',
     title        TEXT  NOT NULL,
     options      JSONB NOT NULL,
     why          TEXT,
     law          TEXT,
     is_published BOOLEAN DEFAULT TRUE,
     sort_order   INT   DEFAULT 0,
     created_at   TIMESTAMPTZ DEFAULT now()
   );`,

  `CREATE TABLE IF NOT EXISTS ratings (
     id BIGSERIAL PRIMARY KEY,
     level_name TEXT NOT NULL,
     min_score  INT  NOT NULL,
     color      TEXT DEFAULT '#E7C46A',
     sort_order INT  DEFAULT 0
   );`,

  `CREATE TABLE IF NOT EXISTS help_resources (
     id BIGSERIAL PRIMARY KEY,
     number      TEXT NOT NULL,
     title       TEXT NOT NULL,
     description TEXT,
     is_active   BOOLEAN DEFAULT TRUE,
     sort_order  INT   DEFAULT 0
   );`,

  `CREATE TABLE IF NOT EXISTS site_settings (
     setting_key   TEXT PRIMARY KEY,
     setting_value JSONB
   );`,

  // 自然键唯一索引：配合 ON CONFLICT DO NOTHING 实现幂等插种
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_sc_content   ON scam_samples(content);`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_sr_cat_con   ON scam_reports(category, content);`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_quiz_sort    ON quiz_questions(sort_order);`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_rating_key   ON ratings(level_name, min_score);`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_help_number  ON help_resources(number);`
];

/* =========================================================
   2) 初始数据（等价于 seed.sql）
      → 想换成你自己的内容，直接改这里的字符串即可，结构不用动
   ========================================================= */
const SEED_GROUPS = [
  {
    table: "ratings",
    statements: [
      `INSERT INTO ratings (level_name, min_score, color, sort_order) VALUES
         ('港盾精英', 1100, '#E7C46A', 1),
         ('金盾',      850, '#E7C46A', 2),
         ('银盾',      600, '#6E9BFF', 3),
         ('铜盾',        0, '#E0894F', 4)
       ON CONFLICT (level_name, min_score) DO NOTHING;`
    ]
  },

  {
    table: "help_resources",
    statements: [
      `INSERT INTO help_resources (number, title, description, sort_order) VALUES
         ('18222', '反诈骗协调中心（ADCC）', '24 小时防骗咨询热线，可即时查询可疑电话、网址、账户，并提供止付与报案指引。', 1),
         ('999', '紧急报警', '如正在发生金钱损失或人身安全风险，立即拨打 999 或前往就近警署报案，保留所有聊天与转账记录。', 2),
         ('SCAMETER', '防骗视伏器', '输入电话号码、网址、收款账户或社交账号，查询是否曾被举报为诈骗相关（香港警务处公开工具）。', 3)
       ON CONFLICT (number) DO NOTHING;`
    ]
  },

  {
    table: "scam_samples",
    statements: [
      `INSERT INTO scam_samples (content, sort_order) VALUES
         ('常见话术样本 ·「这里是入境事务处，你的签证有问题」', 1),
         ('「把你的银行户口借我代收货款，佣金 8%」', 2),
         ('「业主在国外，先付两个月押金才能看房」', 3),
         ('「老师带你买虚拟货币，稳赚不赔」', 4),
         ('「不要告诉任何人，否则影响你的居留」', 5),
         ('反诈骗协调中心热线 18222 · 紧急报警 999', 6)
       ON CONFLICT (content) DO NOTHING;`
    ]
  },

  {
    table: "scam_reports",
    statements: [
      `INSERT INTO scam_reports (category, content, sort_order) VALUES
         ('骗术类型', '假冒政府官员 +「安全账户」转账（高仿「冒充公检法」变种，针对新来港群体）。', 1),
         ('话术特征', '①「我是入境事务处职员」——伪造官方身份；②「涉嫌非法务工」——制造罪名恐慌；③「转入安全账户」——诱导资金转移；④「不要告诉任何人」——切断社交联防；⑤境外号码伪装本地号段。', 2),
         ('法律口径', '入境事务处、警方、银行绝不会通过电话要求你转账至「安全账户」，更不会要求你远程安装屏幕共享 App 或索要一次性验证码。', 3),
         ('建议动作', '立即挂线 → 不回拨该号码 → 通过官方渠道核实 → 拨打 18222 或就近警署报案 → 已转账立即联系银行申请止付。', 4),
         ('权威来源', '香港警务处反诈骗协调中心 ADCC · 防骗视伏器 Scameter · 金管局防骗指引。', 5)
       ON CONFLICT (category, content) DO NOTHING;`
    ]
  },

  {
    table: "site_settings",
    statements: [
      `INSERT INTO site_settings (setting_key, setting_value) VALUES
         ('lock_threshold', '50000'),
         ('lock_verdict_triggered', '"触发「双锁联保」· 2 小时冷静期"'),
         ('lock_verdict_normal', '"未触发 · 低于 {n} 港元阈值（仍建议核实收款人身份）"'),
         ('lock_steps', '["系统识别：个人账户收款 · 金额触发阈值","弹出「冷静期」提示与骗术特征科普","向信任人（妈妈 / 导师）发送独立授权请求","双人确认后 2 小时生效，期间可撤回"]'),
         ('health_weights', '{"fast":0.45,"night":0.30,"ip":0.25}'),
         ('health_levels', '[{"min":0,"max":34,"verdict":"账户状态良好","color":"#3FD0A8","border":"rgba(63,208,168,.5)","action":"保持良好习惯：不要出借账户、提款卡或验证码。"},{"min":35,"max":64,"verdict":"轻度异常 · 建议自查","color":"#E7C46A","border":"rgba(231,196,106,.5)","action":"回忆近期是否有他人要求你「代收代付」，如有请立即停止并保留聊天记录。"},{"min":65,"max":84,"verdict":"高危 · 可能已被用作傀儡户口","color":"#FF8A7E","border":"rgba(226,58,46,.5)","action":"请立即停止所有代收代付，保存证据，拨打 18222 或到警署备案。"},{"min":85,"max":100,"verdict":"极度危险 · 立即止付","color":"#E23A2E","border":"rgba(226,58,46,.7)","action":"你的账户很可能正被用于洗钱，请马上联系银行冻结并报警 999，出借账户可能触犯《有组织及严重罪行条例》。"}]')
       ON CONFLICT (setting_key) DO NOTHING;`
    ]
  },

  {
    table: "quiz_questions",
    statements: [
      `INSERT INTO quiz_questions (tag, script, title, options, why, law, sort_order) VALUES (
         '冒充官员',
         '[["来电","「你好，这里是香港入境事务处。系统显示你的签证资料有异常。」"],["来电","「这件事涉密，你现在必须保持通话，不要告诉任何人，否则影响你的居留。」"],["你","「我…我需要做什么？」"],["来电","把存款转到我们的『安全账户』做资金审查，马上。」"]]'::jsonb,
         '面对这段对话，你第一步应该做什么？',
         '[{"t":"按对方要求保持通话，找一个没人的地方继续配合","ok":false},{"t":"挂线后，自己拨打入境事务处官方热线核实","ok":true},{"t":"先转一小笔钱试试账户是不是真的安全","ok":false},{"t":"把电话给室友听，让对方再解释一遍","ok":false}]'::jsonb,
         '一切冒充官员骗术的核心是「切断你与外界的联系」。挂线并主动拨打官方号码，是成本最低、最有效的核验方式。任何自称官方、要求你把钱转入『安全账户』的人，都是骗子。',
         '官方口径：香港入境事务处绝不会通过电话要求转账或索取银行资料。举报/咨询 18222 · 紧急 999',
         1) ON CONFLICT (sort_order) DO NOTHING;`,

      `INSERT INTO quiz_questions (tag, script, title, options, why, law, sort_order) VALUES (
         '傀儡户口',
         '[["WhatsApp","「同学你好，我是做跨境电商的。想借你的银行户口代收货款，佣金 8%，每天一结。」"],["WhatsApp","「只是走个流水，不犯法的，很多同学都在做。」"],["WhatsApp","「把你提款卡和验证码发我，今晚就可以开始。」"]]'::jsonb,
         '对方要借你的户口代收货款，正确的做法是？',
         '[{"t":"只借户口、不给提款卡，风险应该可控","ok":false},{"t":"明确拒绝，并保留聊天记录，必要时向警方举报","ok":true},{"t":"先做一单看看佣金是否到账","ok":false},{"t":"介绍给其他同学，大家一起赚","ok":false}]'::jsonb,
         '出借银行账户供他人收款，是典型的「傀儡户口」（人头账户）套路。即便你不知情，账户一旦被用于接收赃款，你也可能被认定为洗钱链条一环，面临刑事检控、账户冻结、信用黑名单。',
         '法律风险：出借/出售银行账户可能触犯《有组织及严重罪行条例》《盗窃罪条例》下的洗钱或欺诈罪行。',
         2) ON CONFLICT (sort_order) DO NOTHING;`,

      `INSERT INTO quiz_questions (tag, script, title, options, why, law, sort_order) VALUES (
         '租房陷阱',
         '[["微信","「房子很抢手，我现在在国外出差，没法带看。」"],["微信","「你先付两个月押金 + 首月租金共 HK$52,000，我寄钥匙给你。」"],["微信","「今天不付就租给别人了。」"]]'::jsonb,
         '这套「人在外地、先付款后看房」的房子，你怎么处理？',
         '[{"t":"先付押金锁定房源，毕竟价格很划算","ok":false},{"t":"要求视频看房、核验产权或代理授权，并坚持签正式租约后再付款","ok":true},{"t":"只付一半押金试探对方","ok":false},{"t":"让对方把身份证照片发过来做担保","ok":false}]'::jsonb,
         '「业主/代理人在外地」「限时抢房」「要求一次性付大额押金」是香港租房诈骗三件套。身份证照片可以伪造，只有实地看房、核对业权或持牌代理（地产代理监管局查册）、签署正式租约才具保障。',
         '参考：香港《地产代理条例》规定持牌代理才可处理租赁；涉及争议可向警方或消费者委员会求助。',
         3) ON CONFLICT (sort_order) DO NOTHING;`,

      `INSERT INTO quiz_questions (tag, script, title, options, why, law, sort_order) VALUES (
         '换汇陷阱',
         '[["小红书","「港币换人民币，汇率 0.92，全网最优，先款后汇，秒到账。」"],["小红书","「走平台太慢，直接转我账户，我这边马上安排。」"],["小红书","「今天汇率好，晚上就没了。」"]]'::jsonb,
         '这个「超优汇率、私人换汇」的渠道，风险在哪？',
         '[{"t":"汇率好是因为对方有内部渠道，风险不大","ok":false},{"t":"对方收款后失联，且资金来源不明，可能牵涉洗钱","ok":true},{"t":"只要金额小就不会有事","ok":false},{"t":"对方发了身份证和营业执照照片，可信","ok":false}]'::jsonb,
         '私人换汇既无监管保障，也常是赃款清洗通道。你转出的是干净的钱，收回来的可能是「待追赃款」，账户有被冻结风险。请使用持牌银行或找换店。',
         '提示：香港《打击洗钱及恐怖分子资金筹集条例》下，无牌经营汇款/找换业务属违法。',
         4) ON CONFLICT (sort_order) DO NOTHING;`,

      `INSERT INTO quiz_questions (tag, script, title, options, why, law, sort_order) VALUES (
         '屏幕共享',
         '[["来电","「我是 XX 银行反洗钱部门，你的账户涉嫌异常交易。」"],["来电","下载这个『安全中心』App 并开启屏幕共享，我指导你操作。"],["来电","「把收到的 6 位验证码念给我，帮你完成账户升级。」"]]'::jsonb,
         '对方让你下载 App 并开启屏幕共享，你会怎么做？',
         '[{"t":"开启共享没关系，反正不转账","ok":false},{"t":"立即挂线，卸载该 App，通过银行官方热线核实","ok":true},{"t":"把验证码念给对方，但不共享屏幕","ok":false},{"t":"让对方先发工作证照片","ok":false}]'::jsonb,
         '屏幕共享 = 把手机完全交给骗子。对方可实时看到你的网银界面、密码、验证码。任何索要一次性验证码的行为都是诈骗，银行客服绝不会这样做。',
         '官方口径：银行不会索要密码或一次性验证码。异常请拨官方客服或 18222。',
         5) ON CONFLICT (sort_order) DO NOTHING;`,

      `INSERT INTO quiz_questions (tag, script, title, options, why, law, sort_order) VALUES (
         '冒充客服',
         '[["短信","「【某快递】你的包裹因含有违禁品被海关扣押，请点击链接配合调查。」"],["短信","链接：hxxp://hk-customs-serve.cc/verify"],["短信","「请在 24 小时内完成身份验证，否则包裹销毁并影响你的征信。」"]]'::jsonb,
         '这条「快递 + 海关」短信，你该怎么处理？',
         '[{"t":"点链接输入资料自证清白","ok":false},{"t":"不点链接，通过快递公司官方 App / 客服核实，并举报该短信号码","ok":true},{"t":"回复短信问清楚是什么违禁品","ok":false},{"t":"把链接转发给朋友帮你看","ok":false}]'::jsonb,
         '伪冒短信号码与钓鱼网址是常见手法，域名与官方毫无关系。任何要求点击陌生链接、输入身份证与银行资料的短信，一律通过官方渠道核实。',
         '官方工具：防骗视伏器 Scameter 可查询网址/号码/账户是否涉诈。',
         6) ON CONFLICT (sort_order) DO NOTHING;`,

      `INSERT INTO quiz_questions (tag, script, title, options, why, law, sort_order) VALUES (
         '求职陷阱',
         '[["Telegram","「线上兼职，动动手指点赞刷单，首单返现 30 元。」"],["Telegram","「完成 3 单后佣金提高到 12%，但需先垫付 5000 元做组合单。」"],["Telegram","「做满 10 单一次性返佣 + 本金，很多学生都做。」"]]'::jsonb,
         '这个「点赞刷单、垫付做任务」的兼职，问题出在哪？',
         '[{"t":"前期能正常返现，做到垫付那一步再停","ok":false},{"t":"刷单本身违法且是经典连环套，立即退出并举报","ok":true},{"t":"垫付金额不大可以试一次","ok":false},{"t":"让对方先签电子合同","ok":false}]'::jsonb,
         '「先返小利、后骗大额」是刷单诈骗的标准剧本。前期返现只是诱饵，垫付后会以「任务未完成」「系统卡单」为由不断要求追加。',
         '提示：参与刷单虚构交易可能违反平台规则并涉及欺诈，受害人亦可能承担法律风险。',
         7) ON CONFLICT (sort_order) DO NOTHING;`,

      `INSERT INTO quiz_questions (tag, script, title, options, why, law, sort_order) VALUES (
         'AI 伪造',
         '[["微信语音","「（声音酷似家人）我手机摔坏了，用同事手机联系你。」"],["微信语音","「朋友急用钱，你先转 2 万给他，明天还你。」"],["微信语音","「别打我原来号码，接不到，直接转就好。」"]]'::jsonb,
         '声音很像家人的紧急借钱，你怎么核实？',
         '[{"t":"声音确实是家人的，先转一半","ok":false},{"t":"挂断后用平时的号码回拨，或通过视频、共同亲友等独立渠道核实","ok":true},{"t":"让对方再说几句确认","ok":false},{"t":"先转 2000 元试探","ok":false}]'::jsonb,
         'AI 语音克隆只需几秒录音即可仿冒。声音不再是身份凭证，必须通过原有号码回拨、视频通话、家庭暗号等独立渠道交叉验证。',
         '提示：深度伪造技术已被用于诈骗，任何「换号码借钱」都应先核实身份。',
         8) ON CONFLICT (sort_order) DO NOTHING;`,

      `INSERT INTO quiz_questions (tag, script, title, options, why, law, sort_order) VALUES (
         '杀猪盘 Boss 关',
         '[["IG 私信","「你也喜欢爬山？我住在中环，做量化交易。」"],["3 周后","「我带你在一个平台小赚一笔，本金放你自己的账户。」"],["2 个月后","「把留学准备金全部放进去，我带你做一单大的，机会只有一次。」"],["现在","「平台显示盈利 80 万，但要先交 12% 税才能提现。」"]]'::jsonb,
         '「先交税才能提现」的 80 万盈利，你信吗？',
         '[{"t":"交税说明盈利是真的，值得交","ok":false},{"t":"这是典型的杀猪盘收网动作：平台数字是假的，立即停止投入并报警","ok":true},{"t":"只提现本金部分试试","ok":false},{"t":"让对方垫付税款","ok":false}]'::jsonb,
         '长期经营感情（养猪）→ 引导到假平台（杀猪）→ 以「税费」「保证金」「解冻金」继续收割。真平台提现不会要求额外付费。投入的每一笔都已进入骗子口袋。',
         '官方工具：防骗视伏器 Scameter 可查询平台网址/收款账户。咨询 18222。',
         9) ON CONFLICT (sort_order) DO NOTHING;`,

      `INSERT INTO quiz_questions (tag, script, title, options, why, law, sort_order) VALUES (
         '交易诈骗',
         '[["Carousell","「相机我先付款了，这是平台的收款截图。」"],["WhatsApp","「客服说你没开通卖家收款权限，先转 3000 保证金才能到账。」"],["WhatsApp","官方客服:service-hk@carousell-support.cc"]]'::jsonb,
         '「买家」说钱已付但要你交保证金，你怎么判断？',
         '[{"t":"截图显示已付款，交保证金就能拿到钱","ok":false},{"t":"只认自己银行账户实际入账，官方客服不会用私人邮箱索要保证金","ok":true},{"t":"让买家先垫付保证金","ok":false},{"t":"换个账号再交易一次","ok":false}]'::jsonb,
         '伪造付款截图 + 假冒平台客服是最常见的二手交易骗局。判断标准只有一条：钱有没有真的进到你自己的账户。',
         '提示：平台官方客服不会通过私人邮箱/WhatsApp 处理收款事宜。',
         10) ON CONFLICT (sort_order) DO NOTHING;`,

      `INSERT INTO quiz_questions (tag, script, title, options, why, law, sort_order) VALUES (
         '奖学金诈骗',
         '[["邮件","「【教务处】你获得本年度专项奖学金 HK$28,000，请点击链接填写银行资料领取。」"],["邮件","「链接 24 小时内有效，逾期视为放弃资格。」"],["邮件","发件人：regi-stration@hk-edu-office.net"]]'::jsonb,
         '这封「奖学金到账」邮件，你会怎么做？',
         '[{"t":"链接看着正规，先填了再说","ok":false},{"t":"通过学校官方系统或学生事务处当面/官方邮箱核实，不点邮件链接","ok":true},{"t":"只填姓名不填账户","ok":false},{"t":"转发给同学一起申领","ok":false}]'::jsonb,
         '伪冒学校邮件是针对留学生的高频骗术。发件域名与学校官方域名不一致就是最大破绽；学校发放奖助学金只会通过官方系统通知，不会邮件索取银行密码或验证码。',
         '提示：核对发件域名、通过官方电话或系统二次确认，是最有效的防伪手段。',
         11) ON CONFLICT (sort_order) DO NOTHING;`,

      `INSERT INTO quiz_questions (tag, script, title, options, why, law, sort_order) VALUES (
         '熟人借贷 Boss 关',
         '[["微信","（头像、昵称与你室友完全一致）「在吗？我微信限额了。」"],["微信","「帮我转 8000 给房东，我明天现金还你。」"],["微信","「快点，房东在催，回头请你吃饭。」"]]'::jsonb,
         '「室友」急着让你转 8000 给房东，你怎么做？',
         '[{"t":"室友平时靠谱，先转了","ok":false},{"t":"打语音或当面找室友本人核实，确认是账号被盗","ok":true},{"t":"先转 2000 表示一下","ok":false},{"t":"让对方发语音条确认","ok":false}]'::jsonb,
         '盗号后冒充熟人是经典「熟人借贷」骗术。语音条可伪造，必须用原有联系方式或当面核实。凡涉及转账，一律「先核实身份，再谈钱」。',
         '官方提示：核实身份三步走——换渠道联系、视频或当面、确认后再转账。',
         12) ON CONFLICT (sort_order) DO NOTHING;`
    ]
  }
];

/* =========================================================
   3) SQL 执行兼容层
   getDatabase() 返回的客户端可能暴露：
   - sql   （标签模板函数）→ 以 (strings) 形式调用
   - query / execute / run （纯字符串函数）→ 直接传 SQL 文本
   依次尝试，全部失败才抛错。语句均为幂等写法，重复执行无副作用。
   ========================================================= */
async function runSql(db, text) {
  const attempts = [];

  if (db && typeof db.sql === "function") {
    attempts.push(() => {
      const strings = [text];
      strings.raw = [text];          // 兼容使用 strings.raw 的实现
      return db.sql(strings);
    });
  }
  if (db && typeof db.query === "function")   attempts.push(() => db.query(text));
  if (db && typeof db.execute === "function") attempts.push(() => db.execute(text));
  if (db && typeof db.run === "function")     attempts.push(() => db.run(text));
  if (typeof db === "function") {
    attempts.push(() => {
      const strings = [text];
      strings.raw = [text];
      return db(strings);
    });
  }

  if (!attempts.length) throw new Error("Unsupported database client: no sql runner found");

  let lastErr = null;
  for (const fn of attempts) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("sql execution failed");
}

function firstRow(res) {
  if (!res) return null;
  if (Array.isArray(res)) return res[0] || null;
  if (Array.isArray(res.rows)) return res.rows[0] || null;
  return res;
}

// 表名只来自本文件内的常量，不存在注入面
async function readCount(db, table) {
  const res = await runSql(db, `SELECT COUNT(*) AS total FROM ${table};`);
  const row = firstRow(res) || {};
  const raw = row.total !== undefined ? row.total : row.count;
  const n = parseInt(raw, 10);
  return Number.isNaN(n) ? 0 : n;
}

/* =========================================================
   4) 初始化：建表 → 检查空表 → 补种数据
   同一实例只跑一次（initPromise 缓存）；
   若初始化失败会清空缓存，下次请求可重试。
   ========================================================= */
let initPromise = null;

async function initDatabase(db) {
  // 4.1 建表（逐条执行，IF NOT EXISTS，可重复跑）
  for (const stmt of SCHEMA_STATEMENTS) {
    await runSql(db, stmt);
  }

  // 4.2 逐表检查：为空才插种（INSERT 自带 ON CONFLICT DO NOTHING）
  for (const group of SEED_GROUPS) {
    const count = await readCount(db, group.table);
    if (count > 0) continue;
    for (const stmt of group.statements) {
      await runSql(db, stmt);
    }
  }
}

function ensureReady(db) {
  if (!initPromise) {
    initPromise = initDatabase(db).catch((err) => {
      initPromise = null;   // 允许下次请求重试
      throw err;
    });
  }
  return initPromise;
}

/* =========================================================
   5) 业务查询与响应
   ========================================================= */
function rows(res) {
  if (!res) return [];
  if (Array.isArray(res)) return res;
  return Array.isArray(res.rows) ? res.rows : [];
}

function toSettings(list) {
  const out = {};
  list.forEach((r) => {
    let val = r.setting_value;
    if (typeof val === "string") {
      try { val = JSON.parse(val); } catch (e) { /* 保留原字符串 */ }
    }
    out[r.setting_key] = val;
  });
  return out;
}

function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": statusCode === 200 ? "public, max-age=60" : "no-store"
    },
    body: JSON.stringify(obj)
  };
}

exports.handler = async (event) => {
  if (event && event.httpMethod && event.httpMethod !== "GET") {
    return json(405, { error: "method not allowed" });
  }

  let db;
  try {
    db = await getDatabase();

    // ① 自动建表 + ② 空表补种（仅首次/冷启动）
    await ensureReady(db);

    // ③ 业务查询
    const [samples, reports, questions, ratings, help, settings] = await Promise.all([
      runSql(db, `SELECT * FROM scam_samples   WHERE show_in_ticker = true  ORDER BY sort_order ASC, id ASC;`),
      runSql(db, `SELECT * FROM scam_reports   WHERE is_active = true       ORDER BY sort_order ASC, id ASC;`),
      runSql(db, `SELECT * FROM quiz_questions WHERE is_published = true    ORDER BY sort_order ASC, id ASC;`),
      runSql(db, `SELECT * FROM ratings                                  ORDER BY sort_order ASC, id ASC;`),
      runSql(db, `SELECT * FROM help_resources  WHERE is_active = true     ORDER BY sort_order ASC, id ASC;`),
      runSql(db, `SELECT setting_key, setting_value FROM site_settings;`)
    ]);

    return json(200, {
      scam_samples:   rows(samples),
      scam_reports:   rows(reports),
      quiz_questions: rows(questions),
      ratings:        rows(ratings),
      help_resources: rows(help),
      site_settings:  toSettings(rows(settings))
    });
  } catch (err) {
    // ④ 任何一步失败都降级：返回 500，前端 fallback 到 /data.json
    console.error("[content.js] database error:", err && err.message ? err.message : err);
    return json(500, { error: "database unavailable" });
  }
};
