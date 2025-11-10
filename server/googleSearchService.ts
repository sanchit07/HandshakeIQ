import axios from 'axios';

const GOOGLE_SEARCH_API_KEY = process.env.GOOGLE_SEARCH_API_KEY;
const GOOGLE_SEARCH_ENGINE_ID = process.env.GOOGLE_SEARCH_ENGINE_ID;

if (!GOOGLE_SEARCH_API_KEY || !GOOGLE_SEARCH_ENGINE_ID) {
  console.warn('Google Search API credentials not configured. Search functionality will be limited.');
}

export interface SearchResult {
  title: string;
  link: string;
  snippet: string;
  displayLink: string;
  pagemap?: {
    cse_thumbnail?: Array<{ src: string }>;
    metatags?: Array<{ [key: string]: string }>;
  };
}

export interface PersonSearchResult {
  id: string;
  name: string;
  title: string;
  company: string;
  photoUrl: string;
  email: string;
  linkedInUrl?: string;
  sources: {
    linkedin?: string;
    instagram?: string;
    twitter?: string;
    tiktok?: string;
    facebook?: string;
    blog?: string[];
    news?: string[];
    other?: string[];
  };
  allLinks: string[];
}

interface GoogleSearchResponse {
  items?: SearchResult[];
  searchInformation?: {
    totalResults: string;
  };
}

/**
 * Search Google Custom Search API for a person
 */
export async function searchPerson(
  name: string,
  company?: string,
  designation?: string
): Promise<PersonSearchResult[]> {
  if (!GOOGLE_SEARCH_API_KEY || !GOOGLE_SEARCH_ENGINE_ID) {
    throw new Error('Google Search API not configured');
  }

  // Build search query with LinkedIn focus for better person disambiguation
  let query = `${name} LinkedIn`;
  if (company) query += ` ${company}`;
  if (designation) query += ` ${designation}`;

  try {
    // First search: Find LinkedIn profiles
    const linkedInResults = await performSearch(query, 10);
    
    // Extract unique people from LinkedIn results
    const uniquePeople = extractUniquePeople(linkedInResults, name);

    // For each unique person, gather additional sources
    for (const person of uniquePeople) {
      const additionalLinks = await gatherPersonLinks(person.name, person.company);
      person.allLinks = [...person.allLinks, ...additionalLinks];
      categorizeSources(person);
    }

    return uniquePeople;
  } catch (error) {
    console.error('Error searching for person:', error);
    throw error;
  }
}

/**
 * Perform a Google Custom Search API query
 */
async function performSearch(query: string, num: number = 10): Promise<SearchResult[]> {
  const url = 'https://www.googleapis.com/customsearch/v1';
  
  try {
    const response = await axios.get<GoogleSearchResponse>(url, {
      params: {
        key: GOOGLE_SEARCH_API_KEY,
        cx: GOOGLE_SEARCH_ENGINE_ID,
        q: query,
        num: Math.min(num, 10), // API max is 10 per request
      },
    });

    return response.data.items || [];
  } catch (error) {
    console.error('Google Search API error:', error);
    throw error;
  }
}

/**
 * Extract unique people from LinkedIn search results
 */
function extractUniquePeople(results: SearchResult[], searchName: string): PersonSearchResult[] {
  const peopleMap = new Map<string, PersonSearchResult>();

  for (const result of results) {
    // Look for LinkedIn profile links
    const linkedInMatch = result.link.match(/linkedin\.com\/in\/([a-zA-Z0-9_-]+)/);
    
    if (linkedInMatch) {
      const profileSlug = linkedInMatch[1];
      const linkedInUrl = result.link;

      // Skip if we've already processed this LinkedIn profile
      if (peopleMap.has(linkedInUrl)) {
        peopleMap.get(linkedInUrl)!.allLinks.push(result.link);
        continue;
      }

      // Extract person details from snippet and title
      const personInfo = extractPersonInfo(result, searchName);
      
      if (personInfo) {
        peopleMap.set(linkedInUrl, {
          id: profileSlug,
          name: personInfo.name,
          title: personInfo.title,
          company: personInfo.company,
          photoUrl: personInfo.photoUrl,
          email: `${personInfo.name.toLowerCase().replace(/\s+/g, '.')}@${personInfo.company.toLowerCase().replace(/\s+/g, '')}.com`,
          linkedInUrl,
          sources: {},
          allLinks: [linkedInUrl],
        });
      }
    }
  }

  return Array.from(peopleMap.values());
}

/**
 * Extract person information from search result
 */
function extractPersonInfo(result: SearchResult, searchName: string): {
  name: string;
  title: string;
  company: string;
  photoUrl: string;
} | null {
  // Extract name from title or snippet
  let name = searchName;
  const titleMatch = result.title.match(/^([^|–-]+)/);
  if (titleMatch) {
    const extractedName = titleMatch[1].trim();
    if (extractedName.length < 50 && !extractedName.includes('LinkedIn')) {
      name = extractedName;
    }
  }

  // Extract title and company from snippet
  let title = 'Professional';
  let company = 'Unknown Company';

  // Common LinkedIn snippet patterns
  const snippetPatterns = [
    /(.+?)\s+(?:at|@)\s+(.+?)(?:\||·|•|$)/,
    /(.+?)\s+-\s+(.+?)(?:\||·|•|$)/,
    /(.+?),\s+(.+?)(?:\||·|•|$)/,
  ];

  for (const pattern of snippetPatterns) {
    const match = result.snippet.match(pattern);
    if (match) {
      title = match[1].trim();
      company = match[2].trim();
      break;
    }
  }

  // Extract photo from pagemap thumbnail
  let photoUrl = 'https://ui-avatars.com/api/?name=' + encodeURIComponent(name) + '&background=0D1117&color=22D3EE&size=200';
  if (result.pagemap?.cse_thumbnail?.[0]?.src) {
    photoUrl = result.pagemap.cse_thumbnail[0].src;
  }

  return { name, title, company, photoUrl };
}

/**
 * Gather additional links for a person across various platforms
 */
async function gatherPersonLinks(name: string, company: string): Promise<string[]> {
  const links: string[] = [];
  const queries = [
    `${name} ${company} Instagram`,
    `${name} ${company} Twitter`,
    `${name} ${company} TikTok`,
    `${name} ${company} blog`,
    `${name} ${company} news`,
  ];

  try {
    // Search for additional sources (limit to avoid API quota)
    for (const query of queries) {
      const results = await performSearch(query, 3);
      links.push(...results.map(r => r.link));
    }
  } catch (error) {
    console.error('Error gathering additional links:', error);
  }

  return links;
}

/**
 * Categorize sources by platform
 */
function categorizeSources(person: PersonSearchResult): void {
  person.sources = {
    blog: [],
    news: [],
    other: [],
  };

  for (const link of person.allLinks) {
    const lowerLink = link.toLowerCase();

    if (lowerLink.includes('linkedin.com')) {
      person.sources.linkedin = link;
    } else if (lowerLink.includes('instagram.com')) {
      person.sources.instagram = link;
    } else if (lowerLink.includes('twitter.com') || lowerLink.includes('x.com')) {
      person.sources.twitter = link;
    } else if (lowerLink.includes('tiktok.com')) {
      person.sources.tiktok = link;
    } else if (lowerLink.includes('facebook.com')) {
      person.sources.facebook = link;
    } else if (lowerLink.includes('medium.com') || lowerLink.includes('blog') || lowerLink.includes('wordpress')) {
      person.sources.blog!.push(link);
    } else if (lowerLink.includes('news') || lowerLink.includes('article') || lowerLink.includes('press')) {
      person.sources.news!.push(link);
    } else {
      person.sources.other!.push(link);
    }
  }
}

/**
 * Get all aggregated links for a person to use with Gemini
 */
export function getPersonContext(person: PersonSearchResult): string {
  const contextParts: string[] = [
    `Name: ${person.name}`,
    `Title: ${person.title}`,
    `Company: ${person.company}`,
  ];

  if (person.linkedInUrl) {
    contextParts.push(`LinkedIn: ${person.linkedInUrl}`);
  }

  if (person.sources.instagram) {
    contextParts.push(`Instagram: ${person.sources.instagram}`);
  }

  if (person.sources.twitter) {
    contextParts.push(`Twitter: ${person.sources.twitter}`);
  }

  if (person.sources.tiktok) {
    contextParts.push(`TikTok: ${person.sources.tiktok}`);
  }

  if (person.sources.blog && person.sources.blog.length > 0) {
    contextParts.push(`Blogs: ${person.sources.blog.join(', ')}`);
  }

  if (person.sources.news && person.sources.news.length > 0) {
    contextParts.push(`News: ${person.sources.news.join(', ')}`);
  }

  return contextParts.join('\n');
}
