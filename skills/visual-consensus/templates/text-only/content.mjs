import { block } from 'visual-consensus';

export default {
  // 別の資料を始めるときに固有の ID を付ける。同じ資料の回答を引き継ぐ間は維持する。
  id: 'release-plan',
  title: '公開日程の確認',
  version: 'r1',
  sections: [{
    id: 'delivery',
    title: '公開と告知',
    lead: '担当者が立ち会える日に公開し、利用者へ日程を知らせます。',
    // このセクションの判断（decisions の section: 'delivery'）は、セクションの最後に自動で並ぶ。
    rows: [
      block('dates', '公開候補日', '<p>火曜は担当者が終日、水曜は午前中に立ち会えます。</p>'),
      block('notice', '利用者への案内', '<p>利用者が事前に予定を調整できるよう、メールで公開日を知らせます。</p>'),
    ],
  }],
  decisions: [
    {id: 'D1', section: 'delivery', question: '何曜日に公開しますか？',
      options: ['火曜', '水曜'], recommended: '火曜', context: '火曜なら公開後の問い合わせにも夕方まで対応できます。'},
    {id: 'D2', section: 'delivery', question: '告知メールをいつ送りますか？',
      options: ['前日', '当日'], recommended: '前日', context: '前日に送ると利用者が予定を調整できます。'},
  ],
};
