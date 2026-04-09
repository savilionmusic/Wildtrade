#!/usr/bin/env python3
"""
twscrape bridge for Wildtrade Alpha Intel.
Fetches recent tweets from KOL handles and outputs JSON to stdout.

Usage: python3 twikit_scraper.py handle1 handle2 ...

Credentials are read from env vars:
  TWITTER_USERNAME, TWITTER_PASSWORD, TWITTER_EMAIL (optional)

Account state is cached at ~/.wildtrade_twscrape.db
"""

try:
    from twscrape import API, gather
except ImportError:
    import json, sys
    print(json.dumps({"error": "twscrape not installed", "hint": "pip3 install twscrape"}), flush=True)
    sys.exit(1)

import asyncio
import json
import os
import sys
import traceback

DB_PATH = os.path.expanduser('~/.wildtrade_twscrape.db')


async def main() -> None:
    handles = [h.lstrip('@').strip() for h in sys.argv[1:] if h.strip()]

    if not handles:
        print(json.dumps([]), flush=True)
        return

    username = os.environ.get('TWITTER_USERNAME', '').lstrip('@').strip()
    password = os.environ.get('TWITTER_PASSWORD', '').strip()
    email = os.environ.get('TWITTER_EMAIL', '').strip()

    if not username or not password:
        print(json.dumps({'error': 'No Twitter credentials set. Add TWITTER_USERNAME and TWITTER_PASSWORD in Settings.'}), flush=True)
        sys.exit(1)

    try:
        api = API(DB_PATH)

        # Add/update account (safe to call every run)
        await api.pool.add_account(username, password, email or username, password)

        # Login accounts that aren't active yet
        accts = await api.pool.get_all()
        needs_login = any(not a.active for a in accts)

        if needs_login:
            sys.stderr.write(f'[twikit] Logging in as @{username}...\n')
            await api.pool.login_all()
            accts = await api.pool.get_all()
            if not any(a.active for a in accts):
                print(json.dumps({'error': 'Login failed: account not active after login attempt'}), flush=True)
                sys.exit(1)
            sys.stderr.write('[twikit] Login successful.\n')

    except Exception as e:
        tb = traceback.format_exc()
        sys.stderr.write(f'[twikit] Login exception:\n{tb}\n')
        print(json.dumps({'error': f'Login failed: {str(e)}'}), flush=True)
        sys.exit(1)

    results = []

    for handle in handles:
        try:
            user = await api.user_by_login(handle)
            if not user:
                continue

            tweets = await gather(api.user_tweets(user.id, limit=20))

            for tweet in tweets:
                text = getattr(tweet, 'rawContent', None) or ''
                if not text:
                    continue

                ts = 0
                try:
                    ts = int(tweet.date.timestamp() * 1000)
                except Exception:
                    pass

                results.append({
                    'handle': handle,
                    'id': str(tweet.id),
                    'text': text,
                    'timestamp': ts,
                })

        except Exception as e:
            sys.stderr.write(f'[twikit] Error for @{handle}: {str(e)}\n')

    print(json.dumps(results), flush=True)


asyncio.run(main())
