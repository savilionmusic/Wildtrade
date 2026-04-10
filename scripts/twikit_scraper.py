#!/usr/bin/env python3
"""
twscrape + ntscraper bridge for Wildtrade Alpha Intel.
Fetches recent tweets from KOL handles and outputs JSON to stdout.

Usage: python3 twikit_scraper.py handle1 handle2 ...

Credentials are read from env vars:
  TWITTER_USERNAME, TWITTER_PASSWORD, TWITTER_EMAIL (optional)
  TWITTER_COOKIES — full Cookie-Editor JSON export

Account state is cached at ~/.wildtrade_twscrape.db
"""

try:
    from twscrape import API, gather
except ImportError:
    import json, sys
    print(json.dumps({"error": "twscrape not installed", "hint": "pip3 install twscrape ntscraper"}), flush=True)
    sys.exit(1)

try:
    from ntscraper import Nitter
    NTSCRAPER_AVAILABLE = True
except ImportError:
    NTSCRAPER_AVAILABLE = False

import asyncio
import json
import os
import sys
import traceback

DB_PATH = os.path.expanduser('~/.wildtrade_twscrape.db')
USER_CACHE_PATH = os.path.expanduser('~/.wildtrade_twscrape_user_ids.json')

def load_user_cache() -> dict[str, int]:
    try:
        if os.path.exists(USER_CACHE_PATH):
            with open(USER_CACHE_PATH, 'r') as f:
                return json.load(f)
    except Exception:
        pass
    return {}

def save_user_cache(cache: dict[str, int]) -> None:
    try:
        with open(USER_CACHE_PATH, 'w') as f:
            json.dump(cache, f)
    except Exception:
        pass

user_id_cache = load_user_cache()

async def get_user_id(api, handle: str) -> int | None:
    handle_lower = handle.lower()
    if handle_lower in user_id_cache:
        return user_id_cache[handle_lower]
    
    try:
        user = await api.user_by_login(handle)
        if user and user.id:
            user_id_cache[handle_lower] = user.id
            save_user_cache(user_id_cache)
            return user.id
    except Exception as e:
        sys.stderr.write(f'[twikit] Failed to resolve user ID for @{handle}: {e}\n')
    
    return None

def fetch_via_ntscraper(handles: list[str]) -> list[dict]:
    """Use ntscraper to fetch tweets — it auto-picks a working Nitter instance."""
    if not NTSCRAPER_AVAILABLE:
        sys.stderr.write('[twikit] ntscraper not installed, skipping Nitter fallback.\n')
        return []

    try:
        # First try with instance checking, then without if it fails
        scraper = None
        for skip_check in [False, True]:
            try:
                scraper = Nitter(log_level=0, skip_instance_check=skip_check)
                break
            except Exception:
                if skip_check:
                    raise
                sys.stderr.write('[twikit] ntscraper instance check failed, retrying without check...\n')
                continue

        if scraper is None:
            return []

        results: list[dict] = []

        for handle in handles:
            try:
                data = scraper.get_tweets(handle, mode='user', number=20)
                tweets_raw = data.get('tweets', []) if isinstance(data, dict) else []
                for t in tweets_raw:
                    text = t.get('text', '') or ''
                    tweet_id = ''
                    link = t.get('link', '')
                    if '/status/' in link:
                        tweet_id = link.split('/status/', 1)[1].split('?')[0].strip('/')
                    if not tweet_id or not text:
                        continue
                    date_str = t.get('date', '')
                    ts = 0
                    if date_str:
                        try:
                            from datetime import datetime
                            ts = int(datetime.strptime(date_str, '%b %d, %Y · %I:%M %p UTC').timestamp() * 1000)
                        except Exception:
                            pass
                    results.append({
                        'handle': handle,
                        'id': tweet_id,
                        'text': text,
                        'timestamp': ts,
                    })
            except Exception as e:
                sys.stderr.write(f'[twikit] ntscraper error for @{handle}: {str(e)}\n')

        return results
    except Exception as e:
        sys.stderr.write(f'[twikit] ntscraper init failed: {str(e)}\n')
        return []


async def main() -> None:
    handles = [h.lstrip('@').strip() for h in sys.argv[1:] if h.strip()]

    if not handles:
        print(json.dumps([]), flush=True)
        return

    # Clean stale twscrape DB if it exists but account is inactive (avoids UNIQUE constraint blocking fresh cookies)
    if os.path.exists(DB_PATH):
        try:
            api_check = API(DB_PATH)
            accts = await api_check.pool.get_all()
            all_inactive = accts and all(not getattr(a, 'active', False) for a in accts)
            if all_inactive:
                # Instead of os.remove which breaks twscrape's internal migration state
                # we delete all rows from accounts table
                import sqlite3
                conn = sqlite3.connect(DB_PATH)
                conn.execute("DELETE FROM accounts")
                conn.commit()
                conn.close()
                sys.stderr.write('[twikit] Cleared stale twscrape DB (all accounts inactive).\n')
        except Exception:
            pass

    username = os.environ.get('TWITTER_USERNAME', '').lstrip('@').strip()
    password = os.environ.get('TWITTER_PASSWORD', '').strip()
    email = os.environ.get('TWITTER_EMAIL', '').strip()
    cookies_raw = os.environ.get('TWITTER_COOKIES', '').strip()

    login_error: str | None = None

    # Collect attempted methods for diagnostics
    tried_methods: list[str] = []

    # Primary path: cookie-based twscrape session (no login attempt needed).
    if cookies_raw:
        tried_methods.append('cookies')
        try:
            cookies_list = json.loads(cookies_raw)
            # Build a cookie jar dict — accept both {key,value} and {name,value} formats
            cookie_dict: dict[str, str] = {}
            if isinstance(cookies_list, list):
                for c in cookies_list:
                    name = c.get('name') or c.get('key') or ''
                    value = c.get('value', '')
                    if name and value:
                        cookie_dict[name] = value
            elif isinstance(cookies_list, dict):
                cookie_dict = cookies_list

            if 'auth_token' in cookie_dict and 'ct0' in cookie_dict:
                api = API(DB_PATH)

                # Inject cookie-based account into twscrape pool
                acct_username = username or 'cookie_session'
                try:
                    await api.pool.add_account(
                        acct_username,
                        password or 'unused',
                        email or f'{acct_username}@example.com',
                        password or 'unused',
                    )
                except Exception as add_err:
                    if 'UNIQUE constraint failed' not in str(add_err):
                        raise

                # Set cookies directly (works reliably across twscrape versions)
                # Build "name=value; name=value" string for set_cookies
                cookie_str = '; '.join(f'{k}={v}' for k, v in cookie_dict.items())
                try:
                    await api.pool.set_cookies(acct_username, cookie_str)
                    sys.stderr.write(f'[twikit] Cookie auth: injected {len(cookie_dict)} cookies for @{acct_username}\n')
                except Exception as cookie_err:
                    sys.stderr.write(f'[twikit] set_cookies failed ({cookie_err}), trying direct activation...\n')
                    # Fallback: mark account active and hope the cookies from add_account stuck
                    try:
                        await api.pool.set_active(acct_username, True)
                    except Exception:
                        pass

                results: list[dict] = []
                for handle in handles:
                    try:
                        user_id = await get_user_id(api, handle)
                        if not user_id:
                            continue
                        tweets = await gather(api.user_tweets(user_id, limit=20))
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

                if results:
                    print(json.dumps(results), flush=True)
                    return
                # If we got no results but no hard crash, fall through to RSS
            else:
                sys.stderr.write('[twikit] TWITTER_COOKIES missing auth_token or ct0 — skipping cookie auth.\n')
        except Exception as e:
            tb = traceback.format_exc()
            sys.stderr.write(f'[twikit] Cookie auth exception:\n{tb}\n')
            login_error = f'{type(e).__name__}: {str(e)}'
    if username and password:
        tried_methods.append('login')
        try:
            api = API(DB_PATH)

            # Add account if missing; ignore duplicate inserts.
            try:
                await api.pool.add_account(username, password, email or username, password)
            except Exception as add_err:
                if 'UNIQUE constraint failed' not in str(add_err):
                    raise

            accts = await api.pool.get_all()
            active = any(getattr(a, 'active', False) for a in accts)

            if not active:
                sys.stderr.write(f'[twikit] Logging in as @{username}...\n')
                await api.pool.login_all()
                accts = await api.pool.get_all()
                active = any(getattr(a, 'active', False) for a in accts)
                if not active:
                    raise RuntimeError('account not active after login attempt')
                sys.stderr.write('[twikit] Login successful.\n')

            results: list[dict] = []
            for handle in handles:
                try:
                    user_id = await get_user_id(api, handle)
                    if not user_id:
                        continue

                    tweets = await gather(api.user_tweets(user_id, limit=20))

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

            if results:
                print(json.dumps(results), flush=True)
                return
        except Exception as e:
            tb = traceback.format_exc()
            sys.stderr.write(f'[twikit] Login exception:\n{tb}\n')
            login_error = f'{type(e).__name__}: {str(e)}'

    # Fallback path: ntscraper (auto-selects a working Nitter instance)
    tried_methods.append('nitter')
    sys.stderr.write('[twikit] Trying ntscraper Nitter fallback...\n')
    fallback_results = await asyncio.to_thread(fetch_via_ntscraper, handles)

    if fallback_results:
        sys.stderr.write(f'[twikit] Nitter fallback active — fetched {len(fallback_results)} tweets from {len(handles)} handles.\n')
        print(json.dumps(fallback_results), flush=True)
        return

    methods_str = ', '.join(tried_methods) if tried_methods else 'none configured'
    sys.stderr.write(f'[twikit] All Twitter paths failed for {len(handles)} handles. Tried: {methods_str}\n')
    if login_error:
        sys.stderr.write(f'[twikit] Last error: {login_error}\n')
    if not cookies_raw and not (username and password):
        sys.stderr.write('[twikit] Hint: Add TWITTER_COOKIES (Cookie-Editor JSON) or TWITTER_USERNAME + TWITTER_PASSWORD in Settings.\n')
    print(json.dumps([]), flush=True)


asyncio.run(main())
