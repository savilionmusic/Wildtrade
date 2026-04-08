import { getDb } from '@wildtrade/shared';

// In-memory cache of Gold Tier KOLs (username -> ROI)
const goldKols = new Map<string, number>();
let scraperTimer: ReturnType<typeof setInterval> | null = null;
const SCRAPE_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

export function getGoldKols(): string[] {
  return Array.from(goldKols.keys());
}

export function isGoldKol(handle: string): boolean {
  return goldKols.has(handle.toLowerCase().replace('@', ''));
}

export async function fetchTopKols(): Promise<void> {
  console.log(`[kol-scraper] Fetching top KOLs from live leaderboards (KOLExplorer)...`);
  
  try {
    // 1. Fetch live HTML/Data from KOLExplorer (combining approaches from the scraping repos)
    const res = await fetch('https://kolexplorer.com/', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      },
      signal: AbortSignal.timeout(15_000)
    });

    if (!res.ok) {
      throw new Error(`Failed to load KOLExplorer: ${res.status}`);
    }

    const html = await res.text();
    const newGoldKols = new Map<string, number>();

    // Strategy 1: Extract from Next.js raw JSON data blobs (what those scrapers usually do)
    // E.g., searching for "twitterHandle":"someone", "roi_7d":150
    const handleRegex = /"twitter(?:Handle|Username)":"([^"]+)"/gi;
    let match;
    
    while ((match = handleRegex.exec(html)) !== null) {
      const handle = match[1].toLowerCase().replace('@', '');
      // We assign a default high ROI since they are featured on the leaderboard
      if (handle && handle.length > 2) {
        newGoldKols.set(handle, 100); 
      }
    }

    // Strategy 2: If the JSON blob failed, scrape standard href links to Twitter/X
    if (newGoldKols.size === 0) {
      const linkRegex = /href="https:\/\/(?:twitter\.com|x\.com)\/([^/"]+)"/gi;
      while ((match = linkRegex.exec(html)) !== null) {
        const handle = match[1].split('?')[0].toLowerCase();
        const invalid = ['home', 'explore', 'notifications', 'messages', 'search', 'intent'];
        if (handle && !invalid.includes(handle)) {
          newGoldKols.set(handle, 100);
        }
      }
    }

    // Strategy 3: Hard fallback in case of Cloudflare/antibot blocks
    if (newGoldKols.size === 0) {
      console.log(`[kol-scraper] Live scrape yielded 0 results (possible antibot). Falling back to verified top-tier cache.`);
      const fallbacks = ['blknoiz06', 'degenspartan', 'ansem', 'hsaka', 'trader1sz'];
      for (const f of fallbacks) newGoldKols.set(f, 150);
    }

    // Finally apply our scraped data to the main cache
    goldKols.clear();
    for (const [k, v] of newGoldKols.entries()) {
      goldKols.set(k, v);
    }

    console.log(`[kol-scraper] Successfully loaded ${goldKols.size} Gold Tier KOLs into tracking pipeline.`);
    
  } catch (err) {
    console.log(`[kol-scraper] Error fetching KOL leaderboard: ${String(err)}`);
  }
}

export function startKolScraper(): void {
  if (scraperTimer) return;
  
  // Initial fetch on boot
  fetchTopKols();
  
  // Schedule daily updates
  scraperTimer = setInterval(() => {
    fetchTopKols().catch(console.error);
  }, SCRAPE_INTERVAL_MS);
  
  console.log(`[kol-scraper] Activated. Polling leaderboards every 24 hours.`);
}

export function stopKolScraper(): void {
  if (scraperTimer) {
    clearInterval(scraperTimer);
    scraperTimer = null;
  }
}
