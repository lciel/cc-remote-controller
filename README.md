# CC Remote Controller

スマートフォンから LAN 経由で Claude Code を操作するリモートコントローラー。

---

> **⚠️ 警告: このツールを使用する前に必ずお読みください**
>
> **このツールは、あなたの PC 上で Claude Code をリモート実行します。**
>
> - **信頼できないネットワークでは絶対に使用しないでください。** HTTP 平文通信のため、公共 Wi-Fi やオープンなネットワークではトークンが傍受される危険があります。信頼できる LAN 内でのみ使用してください。
> - **Claude Code に広範な権限を事前付与する必要があります。** リモート操作では都度の許可確認ができないため、ファイルの読み書き・コマンド実行などの権限をあらかじめ付与した状態で動作します。これは実質的に、スマートフォンから PC 上で任意のコードを実行できることを意味します。
> - **トークンの管理は自己責任です。** 認証トークンが漏洩した場合、第三者があなたの PC 上で Claude Code を操作できます。トークンが漏洩した疑いがある場合は、直ちにサーバーを停止し、`.env` の `AUTH_TOKEN` を変更するか、削除して再起動してください（未設定なら起動時に新しいトークンが自動生成されます）。
>
> **これらのリスクを理解したうえで、自己責任でご利用ください。**

---

## Features

- スマートフォンから Claude Code を操作（プロンプト送信・リアルタイムログ閲覧）
- 複数プロジェクト（リポジトリ）の管理
- WebSocket によるリアルタイムストリーミング
- PWA 対応

## Requirements

- Node.js v21 以上
- Claude Code（インストール・認証済み）
- Mac / Linux / Windows（WSL2 経由）

## Setup

```bash
git clone https://github.com/lciel/cc-remote-controller.git
cd cc-remote-controller
npm install
npm run build
npm start
```

起動するとターミナルに QR コードが表示されます。スマートフォンのカメラで読み取ると、ブラウザが開いて自動的に接続されます。

## Usage

### 接続

1. サーバーを起動する
2. ターミナルに表示される QR コードをスマートフォンで読み取る
3. ブラウザが開き、認証トークンが自動保存される

QR コードが使えない場合は、ターミナルに表示される URL をブラウザで開くか、アプリの Settings（⚙ アイコン）からトークンを手入力してください。

### 基本操作

1. 「+ Add Project」からプロジェクト名とリポジトリパス（サーバー上の絶対パス）を登録
2. プロジェクトをタップして詳細画面を開く
3. プロンプトを入力して送信 → Claude Code がリアルタイムで実行される

## Configuration

`.env` ファイルを作成することで設定をカスタマイズできます。設定しなくても動作します。

| 変数 | 説明 | デフォルト |
|---|---|---|
| `AUTH_TOKEN` | 認証トークン。未設定の場合、起動時に自動生成される | 自動生成 |
| `HOST_URL` | QR コードに使用する URL（例: `http://192.168.1.100:8787`）。未設定の場合、ネットワークインターフェースから自動検出 | 自動検出 |
| `PORT` | サーバーのポート番号 | `8787` |
| `DB_PATH` | SQLite データベースのパス | `./data/sessions.db` |

## WSL2 での利用

WSL2 環境では追加の設定が必要です。

### Firewall の許可

Windows Firewall はデフォルトで受信接続をブロックします。ポート 8787 を許可してください。

PowerShell（管理者権限）で以下を実行:

```powershell
netsh advfirewall firewall add rule name="CC Remote Controller" dir=in action=allow protocol=TCP localport=8787
```

### ポートフォワーディング

WSL2 はホストマシンとは別の仮想ネットワーク上で動作するため、LAN からアクセスするにはポートフォワーディングが必要です。

PowerShell（管理者権限）で以下を実行:

```powershell
netsh interface portproxy add v4tov4 listenport=8787 listenaddress=0.0.0.0 connectport=8787 connectaddress=$(wsl hostname -I | ForEach-Object { $_.Trim() })
```

### HOST_URL の設定

WSL2 内から検出される IP はホストの LAN IP とは異なります。`.env` に Windows ホストの LAN IP を指定してください。

```
HOST_URL=http://192.168.1.100:8787
```

## License

MIT
