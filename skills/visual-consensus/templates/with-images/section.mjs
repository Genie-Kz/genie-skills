import { block, fig, mock } from 'visual-consensus';

export const notifications = {
  id: 'notifications',
  title: '通知の受け取り',
  rows: [
    {id: 'report', title: '届いた指摘', type: 'issues'},
    block('before', '今の表示', fig('current', 'メール通知のスイッチが右側にあります。')),
    block('after', '変更案', mock('state-label', '状態を文字で表示',
      '<p>メールで受け取る　<strong>オン</strong></p>')),
  ],
};
