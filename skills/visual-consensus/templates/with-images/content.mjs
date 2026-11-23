import { notifications } from './section.mjs';

export default {
  // 同じ資料の回答を引き継ぐ間は、資料・行・図・指摘の ID を維持する。
  id: 'notification-settings',
  title: '通知設定の表示案',
  version: 'r1',
  sections: [notifications],
  figures: {
    current: {title: '現在の通知設定', file: 'settings.png'},
  },
  issues: [{
    id: 'I-01', sections: ['notifications'], summary: 'スイッチの状態を読み取れる文字がありません。',
    file: 'settings.png', preview: [182, 48, 78, 52],
  }],
};
