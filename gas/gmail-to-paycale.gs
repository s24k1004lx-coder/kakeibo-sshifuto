/**
 * Gmail の「支払い完了メール」を検知して PayCale の Gist 受信箱へ書き込む。
 *
 * PayCale 側は index.html の inbox-import.js が、開くたびに
 * Gist 内の `paycale_inbox_*.json` を支出として取り込み、取り込み後に削除する。
 * このスクリプトはその受信箱にファイルを追加するだけ。
 *
 * セットアップ:
 *   1. https://script.google.com/ で新規プロジェクトを作り、このファイルを貼り付ける
 *      (支払いメールが届く Google アカウントで作ること)
 *   2. 「プロジェクトの設定」→「スクリプト プロパティ」に以下を追加
 *        GH_TOKEN : PayCale のクラウドバックアップで使っている GitHub トークン (gist 権限)
 *        GIST_ID  : PayCale 設定画面「ショートカットに設定する Gist ID」に表示されるID
 *   3. `setup` を1回実行して Gmail へのアクセスを承認 (30分おきのトリガーも作成される)
 *   4. `dryRun` を実行し、ログで「どのメールからいくら読み取るか」を確認してから運用する
 *
 * 二重登録の防止:
 *   処理したメールの ID を スクリプト プロパティ(PROCESSED_IDS)に直近400件ぶん記録し、
 *   同じメールは二度登録しない (同じ件名のメールが1スレッドにまとまっても1通ずつ処理する)。
 */

// ===== 設定: 検知ルール =====
// query      : Gmail の検索演算子 (直近 WINDOW_DAYS 日は自動で付く)
// amountRe   : 金額を取り出す正規表現 (第1キャプチャが数字)。配列なら先頭から順に試す
// shopRe     : 店名/メモを取り出す正規表現 (第1キャプチャ。無ければ件名を使う)
// memoPrefix : メモの先頭に付ける文字 (任意)
// autoCategory: true なら、下の CATEGORY_KEYWORDS で category を自動判定 (当てはまらなければ category)
// category   : PayCale のカテゴリ
//              (食費/交通費/旅費/交際費/日用品/趣味/嗜好品/固定費/貯金/その他)
// ※ 上から順に評価し、先にマッチしたルールで登録したメールは後続ルールでは無視する。
//   「未検証」と書いたルールは、実際のメールで金額が取れるか dryRun で確認すること。
const WINDOW_DAYS = 3;

const RULES = [
  {
    name: "マクドナルド モバイルオーダー",
    query: "from:nsp.mdj.jp subject:ご注文ありがとうございます",
    amountRe: /ご請求金額[^\d¥￥]{0,12}[¥￥]?\s*([\d,]+)/,
    shopRe: /店舗名[\s:：|]*([^\r\n|]{1,30})/,
    memoPrefix: "マクドナルド ",
    category: "食費",
  },
  {
    name: "ウェンディーズ モバイルオーダー",
    query: "from:wendys-firstkitchen.co.jp subject:ご注文を受け付けました",
    amountRe: /合計金額（税込）[\s:：]*([\d,]+)\s*円/,
    shopRe: /\[ご注文店舗\]\s*([^（\r\n]{1,40})/,
    category: "食費",
  },
  {
    name: "digiq 事前決済 (イベント/予約)",
    query: "from:digiq.jp subject:決済が完了",
    amountRe: /支払金額[:：]\s*([\d,]+)\s*円/,
    shopRe: /【会場名】\s*([^\r\n]{1,40})/,
    category: "交際費",
  },
  {
    name: "Google Play 注文明細",
    query: 'from:googleplay-noreply@google.com (subject:ご注文明細 OR subject:"Order Receipt")',
    amountRe: /(?:合計|Total)[:：]\s*[¥￥]\s*([\d,]+)/,
    shopRe: /アイテム\s*価格\s*([^\r\n（￥¥]{1,40})/,
    memoPrefix: "Google Play: ",
    category: "その他",
  },
  {
    name: "Apple 領収書 (未検証: 金額の書式を要確認)",
    query: "from:email.apple.com subject:領収書",
    amountRe: /(?:合計|Total)[^\d¥￥]{0,20}[¥￥]\s*([\d,]+)/,
    shopRe: /(?:App Store|iTunes Store)\s+([^\r\n|]{1,40})/,
    memoPrefix: "Apple: ",
    category: "その他",
  },
  {
    // 1通に複数の注文が入るので、注文番号ごとに分割して1注文=1件で登録する
    name: "Amazon 注文確認",
    query: "from:auto-confirm@amazon.co.jp subject:注文済み",
    splitRe: /注文番号/,
    amountRe: /合計\s*([\d,]+)\s*JPY/,
    shopRe: /\*\s*([^\r\n]{1,40})/,
    memoPrefix: "Amazon: ",
    category: "日用品",
    autoCategory: true,
  },
  {
    // 上のどれにも当てはまらないメールの受け皿。本文(件名だけでなく)に支払い完了の
    // 文言があり、円の金額が読めれば何でも登録する。誤登録は PayCale 側で削除する前提。
    // 金額は「ラベル付きの金額」を優先し、無ければ本文中の最初の円表記を使う。
    name: "汎用: 支払い/決済完了メール",
    query: '("支払い完了" OR "お支払い完了" OR "支払いが完了" OR "お支払いが完了" OR "支払い済み" OR "決済完了" OR "決済が完了") -category:promotions -from:me',
    amountRe: [
      /(?:お支払い金額|お支払金額|支払い?金額|ご利用金額|決済金額|ご請求金額|請求金額|合計金額|お支払い合計|お支払い総額|総額|合計)[^\d¥￥]{0,15}[¥￥]\s*(\d[\d,]*)/,
      /(?:お支払い金額|お支払金額|支払い?金額|ご利用金額|決済金額|ご請求金額|請求金額|合計金額|お支払い合計|お支払い総額|総額|合計)[^\d¥￥]{0,15}(\d[\d,]*)\s*(?:円|JPY)/,
      /[¥￥]\s*(\d[\d,]*)/,
      /(\d[\d,]*)\s*(?:円|JPY)/,
    ],
    shopRe: /(?:ご利用店|ご利用先|お支払い先|店舗名|加盟店)[\s:：]*([^\r\n]{1,40})/,
    category: "その他",
    autoCategory: true,
  },
];

// ===== カテゴリの自動判定 =====
// autoCategory: true のルールだけ、件名・店名/商品名・本文の冒頭に含まれる語句でカテゴリを決める。
// 上から順に評価して最初に当てはまったものを採用し、どれにも当てはまらなければ
// そのルールの category (既定値) を使う。語句は自由に足してよい。
// (固定費は PayCale の自動天引きと二重になるので、ここでは使わない)
const CATEGORY_KEYWORDS = [
  ["旅費", /航空券|航空|フライト|搭乗|ピーチ|Peach|ジェットスター|スカイマーク|\bANA\b|\bJAL\b|新幹線|宿泊|ホテル|旅館|じゃらん|楽天トラベル|Booking\.com|Agoda|エアトリ|高速バス|夜行バス|レンタカー|ツアー/i],
  ["交通費", /乗車券|定期券|Suica|PASMO|ICOCA|タクシー|電車|乗車|運賃/i],
  ["交際費", /飲み放題|宴会|懇親|歓迎会|送別会|忘年会|新年会|結婚祝|ご祝儀|BBQ/i],
  ["嗜好品", /たばこ|タバコ|煙草|ビール|ワイン|日本酒|ウイスキー|焼酎|酒類|コーヒー豆/i],
  ["趣味", /前売|チケット|ライブ|コンサート|公演|映画|入場券|ゲーム|Steam|PlayStation|Nintendo|書籍|漫画|マンガ|コミック|Kindle|アプリ内|LINE\s*Coin|Netflix|Spotify|イヤホン|ヘッドホン|カメラ|フィギュア/i],
  ["食費", /マクドナルド|ウェンディーズ|モバイルオーダー|レストラン|居酒屋|食品|食料品|飲料|弁当|ピザ|デリバリー|Uber\s*Eats|出前館|グルメ|カフェ|お米|白米|無洗米|お菓子|ミネラルウォーター|ラーメン|寿司/i],
  ["日用品", /化粧品|化粧水|スキンケア|ヘアミルク|ヘアトリートメント|トリートメント|シャンプー|コンディショナー|洗顔|洗剤|柔軟剤|ティッシュ|トイレットペーパー|歯ブラシ|歯磨き|ドラッグストア|日用品|衣類|下着|靴下|ウォーター/i],
];

function guessCategory_(text, fallback) {
  for (const [category, re] of CATEGORY_KEYWORDS) {
    if (re.test(text)) return category;
  }
  return fallback;
}

const INBOX_PREFIX = "paycale_inbox_";
const MAX_PER_RUN = 30;
const MAX_KEEP_IDS = 400;

// ===== エントリポイント =====
function processPaymentMails() { run_(false); }
function dryRun() { run_(true); }   // 書き込み・記録をせず、ログだけ出す

function setup() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === "processPaymentMails")
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger("processPaymentMails").timeBased().everyMinutes(30).create();
  GmailApp.getInboxThreads(0, 1);   // Gmail へのアクセス承認を求めるため
  Logger.log("セットアップ完了: 30分おきに processPaymentMails を実行します");
}

// ===== 本体 =====
function run_(dry) {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty("GH_TOKEN");
  const gistId = props.getProperty("GIST_ID");
  if (!dry && (!token || !gistId)) throw new Error("スクリプト プロパティ GH_TOKEN / GIST_ID を設定してください");

  const done = new Set(JSON.parse(props.getProperty("PROCESSED_IDS") || "[]"));
  const since = Date.now() - WINDOW_DAYS * 24 * 3600 * 1000;
  const files = {};

  for (const rule of RULES) {
    const threads = GmailApp.search(`newer_than:${WINDOW_DAYS}d ${rule.query}`, 0, MAX_PER_RUN);
    for (const th of threads) {
      for (const msg of th.getMessages()) {
        const id = msg.getId();
        if (done.has(id) || msg.getDate().getTime() < since) continue;
        done.add(id);   // 金額が読めなかったメールも再処理しない (後続ルールでの二重処理も防ぐ)
        const items = parse_(rule, msg);
        Logger.log(`[${rule.name}] ${msg.getSubject()} -> ${items.length ? JSON.stringify(items) : "金額を読み取れず(スキップ)"}`);
        items.forEach((item, i) => {
          files[`${INBOX_PREFIX}${msg.getDate().getTime()}_${id}_${i}.json`] = { content: JSON.stringify(item) };
        });
      }
    }
  }

  const n = Object.keys(files).length;
  if (dry) { Logger.log(`dryRun: ${n}件が登録対象です (書き込みはしていません)`); return; }
  if (n) pushToGist_(gistId, token, files);   // 失敗時は例外→記録せず次回再試行
  props.setProperty("PROCESSED_IDS", JSON.stringify(Array.from(done).slice(-MAX_KEEP_IDS)));
  Logger.log(`${n}件を PayCale 受信箱に追加しました`);
}

// 1通のメールから登録する支出の配列を返す (読み取れなければ空配列)
function parse_(rule, msg) {
  // プレーンテキストで読めなければ、HTML からタグを除いた本文でも試す
  const texts = [msg.getPlainBody() || "", stripHtml_(msg.getBody() || "")];
  for (const text of texts) {
    // splitRe があるルールは、区切りごと(先頭の見出し部分は除く)に1件として読む
    const blocks = rule.splitRe ? text.split(rule.splitRe).slice(1) : [text];
    const items = blocks.map(b => parseBlock_(rule, msg, b)).filter(Boolean);
    if (items.length) return items;
  }
  return [];
}

function parseBlock_(rule, msg, text) {
  // amountRe は配列なら先頭から順に試し、最初に正の金額が読めたものを使う
  let amount = 0;
  for (const re of [].concat(rule.amountRe)) {
    const m = text.match(re);
    amount = m ? parseInt(m[1].replace(/,/g, ""), 10) : 0;
    if (amount > 0) break;
  }
  if (!(amount > 0)) return null;
  const shop = rule.shopRe && text.match(rule.shopRe);
  const name = (shop && shop[1].trim()) || msg.getSubject();
  // 注文ごとに分割するルールは、件名に別の注文の商品名が入るので判定に使わない
  const clue = `${rule.splitRe ? "" : msg.getSubject()} ${name} ${text.slice(0, 2000)}`;
  return {
    amount: amount,
    memo: ((rule.memoPrefix || "") + name).slice(0, 60),
    category: rule.autoCategory ? guessCategory_(clue, rule.category) : rule.category,
    date: Utilities.formatDate(msg.getDate(), "Asia/Tokyo", "yyyy-MM-dd"),
  };
}

function stripHtml_(html) {
  return html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, "")
    .replace(/<\/(td|th|tr|p|div|li|h\d)>|<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&yen;/g, "¥").replace(/&amp;/g, "&")
    .replace(/[ \t ]+/g, " ");
}

function pushToGist_(gistId, token, files) {
  const res = UrlFetchApp.fetch(`https://api.github.com/gists/${gistId}`, {
    method: "patch",
    contentType: "application/json",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    payload: JSON.stringify({ files: files }),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() >= 300) {
    throw new Error(`Gist への書き込みに失敗: HTTP ${res.getResponseCode()} ${res.getContentText().slice(0, 200)}`);
  }
}
