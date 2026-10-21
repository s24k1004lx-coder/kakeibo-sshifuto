/**
 * Gmail の「支払い完了メール」を検知して PayCale の Gist 受信箱へ書き込む。
 *
 * PayCale 側は index.html の inbox-import.js が、開くたびに
 * Gist 内の `paycale_inbox_*.json` を支出として取り込み、取り込み後に削除する。
 * このスクリプトはその受信箱にファイルを追加するだけ。
 *
 * セットアップ:
 *   1. https://script.google.com/ で新規プロジェクトを作り、このファイルを貼り付ける
 *   2. 「プロジェクトの設定」→「スクリプト プロパティ」に以下を追加
 *        GH_TOKEN : PayCale のクラウドバックアップで使っている GitHub トークン (gist 権限)
 *        GIST_ID  : PayCale 設定画面「ショートカットに設定する Gist ID」に表示されるID
 *   3. `setup` を1回実行して Gmail へのアクセスを承認 (10分おきのトリガーも作成される)
 *   4. `dryRun` を実行し、ログで「どのメールからいくらを読み取るか」を確認してから運用する
 *
 * 取りこぼし/二重登録の防止:
 *   処理したスレッドには Gmail ラベル `PayCale/登録済み` を付け、検索から除外する。
 */

// ===== 設定: 検知ルール =====
// query     : Gmail の検索演算子 (newer_than は初回の取り込み範囲を絞る)
// amountRe  : 金額を取り出す正規表現 (第1キャプチャが数字)
// shopRe    : 店名/メモを取り出す正規表現 (第1キャプチャ。無ければ件名を使う)
// category  : PayCale のカテゴリ
//             (食費/交通費/旅費/交際費/日用品/趣味/嗜好品/固定費/貯金/その他)
// ※ 送信元・文面はサービスごとに違うので、実際のメールに合わせて調整すること。
const RULES = [
  {
    name: "汎用: 支払い完了メール",
    query: 'newer_than:2d (subject:"支払い完了" OR subject:"お支払い完了" OR subject:"決済完了" OR subject:"ご利用のお知らせ")',
    amountRe: /(?:お支払い金額|支払金額|ご利用金額|決済金額|合計金額|合計)[^\d¥￥]{0,12}[¥￥]?\s*([\d,]+)\s*円?/,
    shopRe: /(?:ご利用店|ご利用先|お支払い先|店舗名|加盟店)[\s:：]*([^\r\n]{1,40})/,
    category: "その他",
  },
];

const LABEL_DONE = "PayCale/登録済み";
const INBOX_PREFIX = "paycale_inbox_";
const MAX_PER_RUN = 30;

// ===== エントリポイント =====
function processPaymentMails() { run_(false); }
function dryRun() { run_(true); }   // 書き込み・ラベル付けをせず、ログだけ出す

function setup() {
  GmailApp.createLabel(LABEL_DONE);
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === "processPaymentMails")
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger("processPaymentMails").timeBased().everyMinutes(10).create();
  Logger.log("セットアップ完了: 10分おきに processPaymentMails を実行します");
}

// ===== 本体 =====
function run_(dry) {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty("GH_TOKEN");
  const gistId = props.getProperty("GIST_ID");
  if (!dry && (!token || !gistId)) throw new Error("スクリプト プロパティ GH_TOKEN / GIST_ID を設定してください");

  const label = GmailApp.getUserLabelByName(LABEL_DONE) || GmailApp.createLabel(LABEL_DONE);
  const files = {};
  const doneThreads = [];

  for (const rule of RULES) {
    const threads = GmailApp.search(`${rule.query} -label:"${LABEL_DONE}"`, 0, MAX_PER_RUN);
    for (const th of threads) {
      // スレッド内の新着メッセージを個別に処理する (同一スレッドに複数の支払いが来ることがある)
      for (const msg of th.getMessages()) {
        if (msg.getDate() < new Date(Date.now() - 2 * 24 * 3600 * 1000)) continue;
        const item = parse_(rule, msg);
        Logger.log(`[${rule.name}] ${msg.getSubject()} -> ${item ? JSON.stringify(item) : "金額を読み取れず(スキップ)"}`);
        if (!item) continue;
        files[`${INBOX_PREFIX}${msg.getDate().getTime()}_${msg.getId()}.json`] = {
          content: JSON.stringify(item),
        };
      }
      doneThreads.push(th);
    }
  }

  const n = Object.keys(files).length;
  if (dry) { Logger.log(`dryRun: ${n}件が登録対象です (書き込みはしていません)`); return; }
  if (n) pushToGist_(gistId, token, files);   // 失敗時は例外→ラベルを付けず次回再試行
  doneThreads.forEach(th => th.addLabel(label));
  Logger.log(`${n}件を PayCale 受信箱に追加しました`);
}

function parse_(rule, msg) {
  const body = msg.getPlainBody() || "";
  const m = body.match(rule.amountRe);
  if (!m) return null;
  const amount = parseInt(m[1].replace(/,/g, ""), 10);
  if (!(amount > 0)) return null;
  const shop = rule.shopRe && body.match(rule.shopRe);
  const memo = ((shop && shop[1].trim()) || msg.getSubject()).slice(0, 60);
  return {
    amount: amount,
    memo: memo,
    category: rule.category,
    date: Utilities.formatDate(msg.getDate(), "Asia/Tokyo", "yyyy-MM-dd"),
  };
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
