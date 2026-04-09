#!/usr/bin/env python3
"""
Twikit bridge for Wildtrade Alpha Intel.
Fetches recent tweets from KOL handles and outputs JSON to stdout.

Usage: python3 twikit_scraper.py handle1 handle2 ...

Credentials are read from env vars:
  TWITTER_USERNAME, TWITTER_PASSWORD, TWITTER_EMAIL (optional)

Cookies are cached at ~/.wildtrade_twitter_cookies.json to avoid
re-logging in on every poll cycle.
"""

try:
    from twikit import Client
except ImportError:
    import json, sys
    print(json.dumps({"error": "twikit not installed", "hint": "pip3 install twikit"}), flush=True)
    sys.exit(1)

import asyncio
import json
import os
import sys
import traceback
from datetime import datetime, timezone

COOKIE_PATH = os.path.expanduser('~/.wildtrade_twitter_cookies.json')


def parse_twitter_date(raw: str) -> int:
    """Parse Twitter date string to millisecond timestamp."""
    for fmt in ('%a %b %d %H:%M:%S +0000 %Y', '%Y-%m-%dT%H:%M:%S.%f%z', '%Y-%m-%dT%H:%M:%S%z'):
        try:
            dt = datetime.strptime(raw, fmt)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return int(dt.timestamp() * 1000)
        except ValueError:
            continue
    return 0


async def main() -> None:
    handles = [h.lstrip('@').strip() for h in sys.argv[1:] if h.strip()]

    if not handles:
        print(json.dumps([]), flush=True)
        return

    username = os.environ.get('TWITTER_USERNAME', '').lstrip('@').strip()
    password = os.environ.get('TWITTER_PASSWORD', '').strip()
    email = os.environ.get('TWITTER_EMAIL', '').strip()

    client = Client('en-US')
    logged_in = False

    # Try cached cookies first (avoids re-login every 2 minutes)
    if os.path.exists(COOKIE_PATH):
        try:
            client.load_cookies(COOKIE_PATH)
            logged_in = True
        except Exception as e:
            sys.stderr.write(f'[twikit] Could not load cookies: {e}\n')

    # Fresh login if needed
    if not logged_in:
        if not username or not password:
            print(json.dumps({'error': 'No Twitter credentials set. Add TWITTER_USERNAME and TWITTER_PASSWORD in Settings.'}), flush=True)
            sys.exit(1)

        try:
            sys.stderr.write(f'[twikit] Logging in as @{username}...\n')
            await client.login(
                auth_info_1=username,
                auth_info_2=email if email else username,
                password=password,
            )
            client.save_cookies(COOKIE_PATH)
            logged_in = True
            sys.stderr.write('[twikit] Login successful. Cookies saved.\n')
        except Exception as e:
            tb = traceback.format_exc()
            sys.stderr.write(f'[twikit] Login exception:\n{tb}\n')
            print(json.dumps({'error': f'Login failed: {str(e)}'}), flush=True)
            sys.exit(1)

    results = []

    for handle in handles:
        try:
            user = await client.get_user_by_screen_name(handle)
            if not user:
                continue

            tweets = await user.get_tweets('Tweets', count=20)

            for tweet in tweets:
                text = (
                    getattr(tweet, 'full_text', None)
                    or getattr(tweet, 'text', None)
                    or ''
                )
                if not text:
                    continue

                tweet_id = str(getattr(tweet, 'id', '') or '')
                if not tweet_id:
                    continue

                ts = 0
                created_at_dt = getattr(tweet, 'created_at_datetime', None)
                created_at_str = getattr(tweet, 'created_at', None)

                if created_at_dt is not None:
                    try:
                        ts = int(created_at_dt.timestamp() * 1000)
                    except Exception:
                        pass
                elif created_at_str:
                    ts = parse_twitter_date(str(created_at_str))

                results.append({
                    'handle': handle,
                    'id': tweet_id,
                    'text': text,
                    'timestamp': ts,
                })

        except Exception as e:
            err_str = str(e)
            # Re-auth errors: delete cookie file so next run does a fresh login
            if 'Could not authenticate' in err_str or '32' in err_str or '89' in err_str:
                try:
                    os.remove(COOKIE_PATH)
                    sys.stderr.write('[twikit] Auth error - deleted stale cookies.\n')
                except Exception:
                    pass
            sys.stderr.write(f'[twikit] Error for @{handle}: {err_str}\n')

    print(json.dumps(results), flush=True)


asyncio.run(main())
