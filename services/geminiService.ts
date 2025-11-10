import { GoogleGenAI, GenerateContentResponse, Type } from "@google/genai";
import { IntelligenceReport } from '../types';

const API_KEY = process.env.API_KEY;

if (!API_KEY) {
  // This is a placeholder for environments where the key is not set.
  // In a real deployed environment, the key would be present.
  console.warn("API_KEY environment variable not set. Gemini API calls will fail.");
}

const ai = new GoogleGenAI({ apiKey: API_KEY! });

export const generateIntelligenceReport = async (personName: string, company: string, allLinks?: string[]): Promise<{ report: IntelligenceReport, sources: any[] }> => {
  try {
    let prompt = `
      Generate a detailed professional and personal intelligence report for "${personName}", associated with "${company}".
      Use information available on the public web via Google Search.`;
    
    if (allLinks && allLinks.length > 0) {
      prompt += `
      
      IMPORTANT: Focus your search on these specific web sources that have already been identified for this person:
      ${allLinks.map((link, index) => `${index + 1}. ${link}`).join('\n')}
      
      Prioritize information from these URLs, especially LinkedIn profiles, social media accounts, blog posts, and news articles. 
      These sources are known to be related to this specific person, so use them to generate more accurate and comprehensive insights.`;
    }
    
    prompt += `
      The output MUST be a single, valid JSON object. Do not include any text, code block markers, or formatting outside of the JSON object itself.
      For each point in the arrays below, you MUST include a "source_indices" field. This field must be an array of zero-based integer indices that correspond to the grounding sources that support the statement in the "text" field.
      The JSON object must have the following structure:
      {
        "summary": "A brief, one-paragraph summary of the person, synthesizing the most important findings.",
        "professionalBackground": {
          "category": "Professional Background",
          "points": [
            { "text": "A bullet point about their career, roles, and key achievements.", "confidence": <A number between 0 and 100 representing confidence in this point based on source quality and corroboration>, "source_indices": [<integer index of source>] },
            { "text": "Another bullet point about their career.", "confidence": <number>, "source_indices": [<integer index>, <another index>] }
          ]
        },
        "recentActivities": {
          "category": "Recent Activities & Online Presence",
          "points": [
            { "text": "A bullet point about recent posts, articles, news, or social media activity.", "confidence": <number>, "source_indices": [<integer index>] }
          ]
        },
        "personalInterests": {
          "category": "Personal Interests & Hobbies",
          "points": [
            { "text": "A bullet point about their known hobbies or interests mentioned publicly.", "confidence": <number>, "source_indices": [<integer index>] }
          ]
        },
        "discussionPoints": {
          "category": "Potential Discussion Points",
          "points": [
            { "text": "A bullet point suggesting a relevant conversation starter or topic for a meeting.", "confidence": <number>, "source_indices": [<integer index>] }
          ]
        }
      }
    `;
    
    const response: GenerateContentResponse = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: prompt,
        config: {
            tools: [{ googleSearch: {} }],
        },
    });

    const text = response.text;
    const sources = response.candidates?.[0]?.groundingMetadata?.groundingChunks || [];

    let report: IntelligenceReport;
    
    try {
        // Attempt to parse the entire text as JSON, as requested in the prompt.
        report = JSON.parse(text);
    } catch (parseError) {
        console.error("Failed to parse JSON response from Gemini:", parseError, "Raw text:", text);
        // Create a fallback report if parsing fails
        report = {
            summary: "The model's response could not be parsed as structured data. The raw, unformatted output is provided below for manual review. This may indicate a temporary issue with the intelligence generation service.",
            professionalBackground: { category: "Professional Background", points: [] },
            recentActivities: { category: "Recent Activities & Online Presence", points: [] },
            personalInterests: { category: "Personal Interests & Hobbies", points: [] },
            discussionPoints: { category: "Potential Discussion Points", points: [] },
        };
    }
    
    // Always include the raw text for transparency and debugging.
    report.rawText = text;
    
    return { report, sources };

  } catch (error) {
    console.error("Error generating intelligence report:", error);
    const errorReport: IntelligenceReport = {
        summary: "A critical error occurred while communicating with the intelligence network. The connection may be unstable or the API key may be invalid. Please check the console for details and try again.",
        professionalBackground: { category: "Professional Background", points: [] },
        recentActivities: { category: "Recent Activities & Online Presence", points: [] },
        personalInterests: { category: "Personal Interests & Hobbies", points: [] },
        discussionPoints: { category: "Potential Discussion Points", points: [] },
        rawText: error instanceof Error ? error.message : String(error)
    };
    return { report: errorReport, sources: [] };
  }
};

export const extractTextFromImage = async (base64Image: string): Promise<{name: string, company: string}> => {
    try {
        const imagePart = {
            inlineData: {
                mimeType: 'image/jpeg',
                data: base64Image,
            },
        };

        const textPart = {
            text: "Analyze this image of a business card. Extract the person's full name and their company name. Return ONLY a valid JSON object with 'name' and 'company' keys."
        };

        const response: GenerateContentResponse = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: { parts: [imagePart, textPart] },
            config: {
                responseMimeType: 'application/json',
                responseSchema: {
                    type: Type.OBJECT,
                    properties: {
                        name: { type: Type.STRING },
                        company: { type: Type.STRING }
                    },
                    required: ['name', 'company']
                }
            }
        });

        const text = response.text;
        const data = JSON.parse(text);
        return { name: data.name || '', company: data.company || '' };

    } catch (error) {
        console.error("Error extracting text from image:", error);
        return { name: '', company: '' };
    }
};