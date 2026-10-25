# telecode

Drive Pi from Telegram. Send a message from your phone, Pi answers it, and the reply lands back on your phone.

## Install

```sh
pi install npm:@roshnicdave/telecode
# or from git:
pi install git:github.com/roshnicdave/telecode
```

## Configure

```sh
export TELEGRAM_BOT_TOKEN="1234567890:AA-your-token"
export TELEGRAM_ALLOWED_IDS="8010764520"   # optional: your Telegram user id
```

Start Pi, then message your bot. It arrives as a normal Pi turn (`[Telegram] ...`), and Pi replies with the `telegram_send` tool.

If `TELEGRAM_BOT_TOKEN` is not set, telecode reads it from `~/.pi/agent/.telegram_token`.

Only one Pi instance polls Telegram at a time; other terminals keep working and take over automatically if the polling one closes.
