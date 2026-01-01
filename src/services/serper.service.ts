import { config } from '../config';

/**
 * SerperService
 * 
 * Provides web scraping and news search capabilities using the SERPER API.
 */

const SERPER_API_URL = 'https://google.serper.dev';

interface SerperNewsResult {
  title: string;
  link: string;
  snippet: string;
  date: string;
  source: string;
  imageUrl?: string;
}

interface SerperScrapeResult {
  title: string;
  url: string;
  text: string;
  markdown?: string;
}

export class SerperService {
  private apiKey: string;

  constructor() {
    this.apiKey = config.serper.apiKey;
    if (!this.apiKey) {
      console.warn('SERPER_API_KEY not configured - web scrape and news search will not work');
    }
  }

  /**
   * Search for news articles
   */
  async searchNews(
    query: string,
    options?: {
      num?: number;
      timeRange?: 'hour' | 'day' | 'week' | 'month' | 'year';
    }
  ): Promise<{
    query: string;
    results: SerperNewsResult[];
    count: number;
  }> {
    if (!this.apiKey) {
      throw new Error('SERPER_API_KEY not configured');
    }

    const response = await fetch(`${SERPER_API_URL}/news`, {
      method: 'POST',
      headers: {
        'X-API-KEY': this.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        q: query,
        num: options?.num || 10,
        tbs: options?.timeRange ? this.getTimeRangeParam(options.timeRange) : undefined,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`SERPER news search failed: ${response.status} - ${error}`);
    }

    const data = await response.json() as any;
    
    const results: SerperNewsResult[] = (data.news || []).map((item: any) => ({
      title: item.title,
      link: item.link,
      snippet: item.snippet,
      date: item.date,
      source: item.source,
      imageUrl: item.imageUrl,
    }));

    return {
      query,
      results,
      count: results.length,
    };
  }

  /**
   * Scrape content from a URL
   */
  async scrapeUrl(url: string): Promise<SerperScrapeResult> {
    if (!this.apiKey) {
      throw new Error('SERPER_API_KEY not configured');
    }

    // Use the scrape endpoint
    const response = await fetch(`${SERPER_API_URL}/scrape`, {
      method: 'POST',
      headers: {
        'X-API-KEY': this.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url: url,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`SERPER scrape failed: ${response.status} - ${error}`);
    }

    const data = await response.json() as any;

    return {
      title: data.title || '',
      url: url,
      text: data.text || '',
      markdown: data.markdown,
    };
  }

  /**
   * Convert time range to SERPER parameter
   */
  private getTimeRangeParam(range: 'hour' | 'day' | 'week' | 'month' | 'year'): string {
    const params: Record<string, string> = {
      hour: 'qdr:h',
      day: 'qdr:d',
      week: 'qdr:w',
      month: 'qdr:m',
      year: 'qdr:y',
    };
    return params[range] || '';
  }
}

// Singleton instance
let serperServiceInstance: SerperService | null = null;

export function getSerperService(): SerperService {
  if (!serperServiceInstance) {
    serperServiceInstance = new SerperService();
  }
  return serperServiceInstance;
}

