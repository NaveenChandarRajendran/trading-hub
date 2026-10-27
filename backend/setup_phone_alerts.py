"""
setup_phone_alerts.py - one-time setup of the phone alerts (owner, 27-Oct-2026). Run it through Setup_Phone_Alerts.bat.
Asks for the Telegram bot key in a hidden prompt (never shown, never in chat, never in git), finds your chat with the
bot, saves both to ~/TradingHubKeys/telegram.json and sends a test message.
"""
import getpass
import json
import os
import sys

import requests

from notify import API, DEFAULT_KEYS_FILE, Notifier


def call(token, method, **params):
    r = requests.get(API.format(token=token, method=method), params=params, timeout=15)
    return r.json() if r.headers.get("content-type", "").startswith("application/json") else {"ok": False}


def main():
    print("Trading Hub phone alerts: one-time setup\n")
    print("Step 1. On your phone, open Telegram and search for  @BotFather  (blue tick).")
    print("Step 2. Send it:  /newbot   then give the bot a name, e.g.  My Trading Hub,")
    print("        and a username ending in 'bot', e.g.  vrushali_tradinghub_bot.")
    print("Step 3. BotFather replies with a long key (looks like 123456:ABC...). Copy it.\n")
    token = getpass.getpass("Paste the key here and press Enter (it stays hidden): ").strip()
    me = call(token, "getMe") if token else {"ok": False}
    if not me.get("ok"):
        sys.exit("That key did not work. Run Setup_Phone_Alerts.bat again and paste the key from BotFather.")
    name = me["result"].get("username")
    print(f"\nKey OK (bot @{name}).")
    print(f"Step 4. In Telegram, open  @{name} , press Start (or send it  hi ).")
    input("        Then press Enter here... ")
    chat = None
    for upd in reversed(call(token, "getUpdates").get("result", [])):
        msg = upd.get("message") or upd.get("my_chat_member") or {}
        if msg.get("chat", {}).get("id"):
            chat = msg["chat"]["id"]
            break
    if chat is None:
        sys.exit(f"No message from you yet. Send  hi  to @{name} in Telegram, then run Setup_Phone_Alerts.bat again.")
    path = os.path.expanduser(DEFAULT_KEYS_FILE)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"botToken": token, "chatId": chat}, f)
    ok, err = Notifier(start=False).send_now("✅ Trading Hub phone alerts are on. You'll get a message on every rule entry and exit, and a day summary after 3:30 PM.")
    if not ok:
        sys.exit(f"Saved, but the test message failed ({err}). Check the internet connection and run it again.")
    print(f"\nDone. Check your phone for the test message. Saved in {path} (outside the Trading Journey folder).")
    print("Restart the backend (or Start_Trading_Day tomorrow) and alerts start automatically.")


if __name__ == "__main__":
    main()
