import axios from 'axios';
import { SearchLink, SocialMediaLink, PersonSearchResult } from '../types';

const GOOGLE_API_KEY = process.env.GOOGLE_SEARCH_API_KEY;
const GOOGLE_CSE_ID = process.env.GOOGLE_CSE_ID;

if (!GOOGLE_API_KEY || !GOOGLE_CSE_ID) {
  console.warn("Google Search API credentials not set. Search functionality will be limited.");
}

interface GoogleSearchResult {
  title: string;
  link: string;
  snippet: string;
  pagemap?: {
    metatags?: Array<{
      [key: string]: string;
    }>;
    cse_image?: Array<{
      src: string;
    }>;
  };
}

interface GoogleSearchResponse {
  items?: GoogleSearchResult[];
  searchInformation?: {
    totalResults: string;
  };
}

function extractSocialMediaLinks(results: GoogleSearchResult[]): SocialMediaLink[] {
  const links: SocialMediaLink[] = [];
  const seenUrls = new Set<string>();

  for (const result of results) {
    const url = result.link.toLowerCase();
    let platform: SocialMediaLink['platform'] | null = null;

    if (url.includes('linkedin.com/in/')) {
      platform = 'linkedin';
    } else if (url.includes('twitter.com/') || url.includes('x.com/')) {
      platform = 'twitter';
    } else if (url.includes('facebook.com/')) {
      platform = 'facebook';
    } else if (url.includes('instagram.com/')) {
      platform = 'instagram';
    } else if (url.includes('github.com/')) {
      platform = 'github';
    }

    if (platform && !seenUrls.has(result.link)) {
      links.push({
        platform,
        url: result.link,
        label: result.title,
      });
      seenUrls.add(result.link);
    }
  }

  return links;
}

function detectPersonVariants(results: GoogleSearchResult[], searchName: string): Map<string, PersonSearchResult> {
  const personMap = new Map<string, PersonSearchResult>();
  
  for (const result of results) {
    const text = `${result.title} ${result.snippet}`.toLowerCase();
    let personName = searchName;
    let title = '';
    let company = '';
    
    const titlePatterns = [
      /(?:ceo|cto|cfo|founder|director|manager|engineer|developer|designer|analyst|consultant|professor|dr\.|president|vp|vice president)\s+(?:of|at)\s+([^\n,.|]+)/i,
      /([^\n,.|]+)\s+(?:ceo|cto|cfo|founder|director|manager|engineer|developer|designer)/i,
    ];
    
    for (const pattern of titlePatterns) {
      const match = result.snippet.match(pattern);
      if (match) {
        const parts = result.snippet.split(/\s+(?:at|,)\s+/);
        if (parts.length >= 2) {
          title = parts[0].trim();
          company = parts[1].split(/[,.|]/)[0].trim();
        }
        break;
      }
    }

    const linkedInMatch = result.link.match(/linkedin\.com\/in\/([^\/]+)/);
    if (linkedInMatch) {
      personName = result.title.split(/[-–|]/)[0].trim() || searchName;
    }

    const key = `${personName.toLowerCase()}_${company.toLowerCase()}`;
    
    if (!personMap.has(key)) {
      personMap.set(key, {
        name: personName,
        title: title || undefined,
        company: company || undefined,
        links: [],
        socialMediaLinks: [],
        snippet: result.snippet,
      });
    }

    const person = personMap.get(key)!;
    person.links.push({
      url: result.link,
      title: result.title,
      snippet: result.snippet,
      source: new URL(result.link).hostname,
    });

    if (result.pagemap?.cse_image?.[0]?.src && !person.photoUrl) {
      person.photoUrl = result.pagemap.cse_image[0].src;
    }
  }

  const allResults = results;
  for (const person of personMap.values()) {
    const personResults = allResults.filter(r => 
      person.links.some(link => link.url === r.link)
    );
    person.socialMediaLinks = extractSocialMediaLinks(personResults);
  }

  return personMap;
}

export async function searchPerson(
  personName: string,
  company?: string,
  designation?: string
): Promise<PersonSearchResult[]> {
  if (!GOOGLE_API_KEY || !GOOGLE_CSE_ID) {
    throw new Error('Google Search API not configured');
  }

  try {
    let query = personName;
    if (company) query += ` ${company}`;
    if (designation) query += ` ${designation}`;

    const response = await axios.get<GoogleSearchResponse>(
      'https://www.googleapis.com/customsearch/v1',
      {
        params: {
          key: GOOGLE_API_KEY,
          cx: GOOGLE_CSE_ID,
          q: query,
          num: 10,
        },
      }
    );

    if (!response.data.items || response.data.items.length === 0) {
      return [];
    }

    const personMap = detectPersonVariants(response.data.items, personName);
    return Array.from(personMap.values());
  } catch (error: any) {
    console.error('Error searching for person:', error);
    if (error.response) {
      console.error('Google API Error Response:', JSON.stringify(error.response.data, null, 2));
    }
    throw error;
  }
}

export async function enhancedPersonSearch(
  personName: string,
  company?: string,
  designation?: string,
  additionalContext?: string
): Promise<PersonSearchResult[]> {
  const results = await searchPerson(personName, company, designation);
  
  if (results.length === 0 && !company && !designation) {
    const fallbackQuery = `${personName} LinkedIn OR Twitter OR Facebook`;
    const response = await axios.get<GoogleSearchResponse>(
      'https://www.googleapis.com/customsearch/v1',
      {
        params: {
          key: GOOGLE_API_KEY,
          cx: GOOGLE_CSE_ID,
          q: fallbackQuery,
          num: 10,
        },
      }
    );

    if (response.data.items) {
      const personMap = detectPersonVariants(response.data.items, personName);
      return Array.from(personMap.values());
    }
  }
  
  return results;
}
