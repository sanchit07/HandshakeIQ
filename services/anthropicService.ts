import Anthropic from '@anthropic-ai/sdk';
import { IntelligenceReport } from '../types';

const MODEL = 'claude-sonnet-4-5';

function getClient(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not configured.');
  }
  return new Anthropic({ apiKey });
}

function extractText(response: Anthropic.Message): string {
  return response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

// Collect web search result sources in the same shape the frontend expects
// (Gemini groundingChunks format: { web: { uri, title } })
function extractSources(response: Anthropic.Message): any[] {
  const sources: any[] = [];
  const seen = new Set<string>();
  for (const block of response.content as any[]) {
    if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
      for (const result of block.content) {
        if (result.type === 'web_search_result' && result.url && !seen.has(result.url)) {
          seen.add(result.url);
          sources.push({ web: { uri: result.url, title: result.title || result.url } });
        }
      }
    }
    // Citations attached to text blocks also carry URLs
    if (block.type === 'text' && Array.isArray(block.citations)) {
      for (const citation of block.citations) {
        if (citation.url && !seen.has(citation.url)) {
          seen.add(citation.url);
          sources.push({ web: { uri: citation.url, title: citation.title || citation.url } });
        }
      }
    }
  }
  return sources;
}

function parseJsonLoose(text: string): any {
  // Claude sometimes wraps JSON in code fences or prose; extract the JSON object.
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced) {
      return JSON.parse(fenced[1].trim());
    }
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start !== -1 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
    throw new Error('No JSON object found in Claude response');
  }
}

// Validate/coerce the model's JSON into a safe IntelligenceReport the UI can render.
function normalizeReport(raw: any, sourceCount: number): IntelligenceReport {
  if (!raw || typeof raw !== 'object' || typeof raw.summary !== 'string' || !raw.summary) {
    throw new Error('Claude response missing summary');
  }
  const normalizeSection = (section: any, fallbackCategory: string, requireTimestamp = false) => {
    const points = Array.isArray(section?.points) ? section.points : [];
    return {
      category: typeof section?.category === 'string' ? section.category : fallbackCategory,
      points: points
        .filter((p: any) => p && typeof p.text === 'string' && p.text)
        .map((p: any) => ({
          text: p.text,
          confidence: typeof p.confidence === 'number' && isFinite(p.confidence)
            ? Math.max(0, Math.min(100, p.confidence))
            : 50,
          source_indices: (Array.isArray(p.source_indices) ? p.source_indices : [])
            .filter((i: any) => Number.isInteger(i) && i >= 0 && i < sourceCount),
          ...(requireTimestamp ? { timestamp: typeof p.timestamp === 'string' ? p.timestamp : '' } : {}),
        })),
    };
  };
  return {
    summary: raw.summary,
    professionalBackground: normalizeSection(raw.professionalBackground, 'Professional Background'),
    recentActivities: normalizeSection(raw.recentActivities, 'Recent Activities & Online Presence', true),
    personalInterests: normalizeSection(raw.personalInterests, 'Personal Interests & Hobbies'),
    discussionPoints: normalizeSection(raw.discussionPoints, 'Potential Discussion Points'),
  };
}

export const generateIntelligenceReportClaude = async (
  personName: string,
  company: string,
  additionalLinks?: string[]
): Promise<{ report: IntelligenceReport; sources: any[] }> => {
  const client = getClient();

  let contextInfo = '';
  if (additionalLinks && additionalLinks.length > 0) {
    contextInfo = `\n\nAdditional context from search results:\n${additionalLinks.join('\n')}`;
  }

  // STEP 1: Web search for grounded information
  const searchPrompt = `
    Search for comprehensive information about "${personName}" who is associated with "${company}".
    ${contextInfo}

    Find and provide detailed information about:
    1. Their professional background, career history, roles, and achievements
    2. Recent activities, news, articles, or social media posts (with specific dates)
    3. Personal interests, hobbies, or causes they support
    4. Notable accomplishments or recognitions

    Include specific details, dates, and facts. Cite your sources, and include any LinkedIn profile URLs you find.
  `;

  console.log(`[CLAUDE API] Step 1: Searching for information about "${personName}" at "${company}"`);

  const searchResponse = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    messages: [{ role: 'user', content: searchPrompt }],
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 6 } as any],
  });

  const searchText = extractText(searchResponse);
  const sources = extractSources(searchResponse);

  console.log(`[CLAUDE API] Step 1: Retrieved ${sources.length} sources, ${searchText.length} chars of text`);

  // STEP 2: Structure the gathered information into JSON
  const structurePrompt = `
    Based on the following information about ${personName}, create a detailed intelligence report.

    INFORMATION:
    ${searchText}

    Each source_indices array should reference the position (0-based index) of these sources:
    ${sources.map((s, i) => `${i}: ${s.web.title} (${s.web.uri})`).join('\n')}

    Return ONLY valid JSON (no markdown, no code blocks) in this exact structure:
    {
      "summary": "A brief, one-paragraph summary of the person, synthesizing the most important findings.",
      "professionalBackground": { "category": "Professional Background", "points": [ { "text": "...", "confidence": <0-100>, "source_indices": [<int>] } ] },
      "recentActivities": { "category": "Recent Activities & Online Presence", "points": [ { "text": "...", "confidence": <0-100>, "source_indices": [<int>], "timestamp": "Month Year or exact date" } ] },
      "personalInterests": { "category": "Personal Interests & Hobbies", "points": [ { "text": "...", "confidence": <0-100>, "source_indices": [<int>] } ] },
      "discussionPoints": { "category": "Potential Discussion Points", "points": [ { "text": "...", "confidence": <0-100>, "source_indices": [<int>] } ] }
    }

    Provide at least 3-5 points in each category if information is available.
  `;

  console.log(`[CLAUDE API] Step 2: Structuring intelligence report for ${personName}`);

  const structureResponse = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    messages: [{ role: 'user', content: structurePrompt }],
  });

  const structuredText = extractText(structureResponse);

  const report = normalizeReport(parseJsonLoose(structuredText), sources.length);

  console.log(`[CLAUDE API] Successfully structured intelligence report for ${personName} with ${sources.length} sources`);

  report.rawText = `=== SEARCH RESULTS ===\n${searchText}\n\n=== STRUCTURED OUTPUT ===\n${structuredText}`;
  return { report, sources };
};

export const extractTextFromImageClaude = async (
  base64Image: string
): Promise<{ name: string; company: string }> => {
  const client = getClient();

  console.log('[CLAUDE API] Extracting text from business card image');

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 512,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/jpeg', data: base64Image },
          },
          {
            type: 'text',
            text: "Analyze this image of a business card. Extract the person's full name and their company name. Return ONLY a valid JSON object with 'name' and 'company' keys, nothing else.",
          },
        ],
      },
    ],
  });

  const data = parseJsonLoose(extractText(response));
  console.log('[CLAUDE API] Successfully extracted:', { name: data.name || 'N/A', company: data.company || 'N/A' });
  return { name: data.name || '', company: data.company || '' };
};
