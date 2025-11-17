import { GoogleGenAI, GenerateContentResponse, Type } from "@google/genai";
import { IntelligenceReport } from '../types';

const API_KEY = process.env.GEMINI_API_KEY;

if (!API_KEY) {
  // This is a placeholder for environments where the key is not set.
  // In a real deployed environment, the key would be present.
  console.warn("GEMINI_API_KEY environment variable not set. Gemini API calls will fail.");
}

const ai = new GoogleGenAI({ apiKey: API_KEY! });

export const generateIntelligenceReport = async (
  personName: string, 
  company: string, 
  additionalLinks?: string[]
): Promise<{ report: IntelligenceReport, sources: any[] }> => {
  try {
    let contextInfo = '';
    if (additionalLinks && additionalLinks.length > 0) {
      contextInfo = `\n\nAdditional context from search results:\n${additionalLinks.join('\n')}`;
    }
    
    // STEP 1: Use Google Search to get grounded information
    const searchPrompt = `
      Search for comprehensive information about "${personName}" who is associated with "${company}".
      ${contextInfo}
      
      Find and provide detailed information about:
      1. Their professional background, career history, roles, and achievements
      2. Recent activities, news, articles, or social media posts (with specific dates)
      3. Personal interests, hobbies, or causes they support
      4. Notable accomplishments or recognitions
      
      Include specific details, dates, and facts. Cite your sources.
    `;
    
    const searchResponse: GenerateContentResponse = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: [{ role: "user", parts: [{ text: searchPrompt }] }],
        tools: [{ googleSearch: {} }]
    });

    const searchText = (searchResponse as any).response?.text() || '';
    const sources = (searchResponse as any).response?.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
    
    console.log(`Step 1: Retrieved ${sources.length} sources for ${personName}`);
    
    // STEP 2: Structure the gathered information into proper JSON format
    const structurePrompt = `
      Based on the following information about ${personName}, create a detailed intelligence report.
      
      INFORMATION:
      ${searchText}
      
      Generate a structured intelligence report with the following format. Each source_indices array should reference the position (0-based index) of sources from the search results.
      
      Return ONLY valid JSON in this exact structure (no markdown, no code blocks):
      {
        "summary": "A brief, one-paragraph summary of the person, synthesizing the most important findings.",
        "professionalBackground": {
          "category": "Professional Background",
          "points": [
            { 
              "text": "A bullet point about their career, roles, and key achievements with specific details.", 
              "confidence": <A number between 0 and 100>, 
              "source_indices": [<integer index of source, 0-based>] 
            }
          ]
        },
        "recentActivities": {
          "category": "Recent Activities & Online Presence",
          "points": [
            { 
              "text": "A bullet point about recent posts, articles, news, or social media activity with specific details.", 
              "confidence": <number>, 
              "source_indices": [<integer index>],
              "timestamp": "Month Year or exact date when this occurred"
            }
          ]
        },
        "personalInterests": {
          "category": "Personal Interests & Hobbies",
          "points": [
            { 
              "text": "A bullet point about their known hobbies or interests mentioned publicly.", 
              "confidence": <number>, 
              "source_indices": [<integer index>] 
            }
          ]
        },
        "discussionPoints": {
          "category": "Potential Discussion Points",
          "points": [
            { 
              "text": "A bullet point suggesting a relevant conversation starter or topic for a meeting.", 
              "confidence": <number>, 
              "source_indices": [<integer index>] 
            }
          ]
        }
      }
      
      Provide at least 3-5 points in each category if information is available.
    `;
    
    const structureResponse: GenerateContentResponse = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: [{ role: "user", parts: [{ text: structurePrompt }] }],
        config: {
            responseMimeType: 'application/json',
            responseSchema: {
                type: Type.OBJECT,
                properties: {
                    summary: { type: Type.STRING },
                    professionalBackground: {
                        type: Type.OBJECT,
                        properties: {
                            category: { type: Type.STRING },
                            points: {
                                type: Type.ARRAY,
                                items: {
                                    type: Type.OBJECT,
                                    properties: {
                                        text: { type: Type.STRING },
                                        confidence: { type: Type.NUMBER },
                                        source_indices: {
                                            type: Type.ARRAY,
                                            items: { type: Type.NUMBER }
                                        }
                                    },
                                    required: ['text', 'confidence', 'source_indices']
                                }
                            }
                        },
                        required: ['category', 'points']
                    },
                    recentActivities: {
                        type: Type.OBJECT,
                        properties: {
                            category: { type: Type.STRING },
                            points: {
                                type: Type.ARRAY,
                                items: {
                                    type: Type.OBJECT,
                                    properties: {
                                        text: { type: Type.STRING },
                                        confidence: { type: Type.NUMBER },
                                        source_indices: {
                                            type: Type.ARRAY,
                                            items: { type: Type.NUMBER }
                                        },
                                        timestamp: { type: Type.STRING }
                                    },
                                    required: ['text', 'confidence', 'source_indices', 'timestamp']
                                }
                            }
                        },
                        required: ['category', 'points']
                    },
                    personalInterests: {
                        type: Type.OBJECT,
                        properties: {
                            category: { type: Type.STRING },
                            points: {
                                type: Type.ARRAY,
                                items: {
                                    type: Type.OBJECT,
                                    properties: {
                                        text: { type: Type.STRING },
                                        confidence: { type: Type.NUMBER },
                                        source_indices: {
                                            type: Type.ARRAY,
                                            items: { type: Type.NUMBER }
                                        }
                                    },
                                    required: ['text', 'confidence', 'source_indices']
                                }
                            }
                        },
                        required: ['category', 'points']
                    },
                    discussionPoints: {
                        type: Type.OBJECT,
                        properties: {
                            category: { type: Type.STRING },
                            points: {
                                type: Type.ARRAY,
                                items: {
                                    type: Type.OBJECT,
                                    properties: {
                                        text: { type: Type.STRING },
                                        confidence: { type: Type.NUMBER },
                                        source_indices: {
                                            type: Type.ARRAY,
                                            items: { type: Type.NUMBER }
                                        }
                                    },
                                    required: ['text', 'confidence', 'source_indices']
                                }
                            }
                        },
                        required: ['category', 'points']
                    }
                },
                required: ['summary', 'professionalBackground', 'recentActivities', 'personalInterests', 'discussionPoints']
            }
        },
    });

    const structuredText = (structureResponse as any).response?.text() || '';

    let report: IntelligenceReport;
    
    try {
        // Parse the JSON response - responseSchema guarantees proper JSON format
        report = JSON.parse(structuredText);
        console.log(`Step 2: Successfully structured intelligence report for ${personName} with ${sources.length} sources`);
    } catch (parseError) {
        console.error("Failed to parse structured JSON response:", parseError, "Raw text:", structuredText);
        // Create a fallback report if parsing fails
        report = {
            summary: "The model's response could not be parsed as structured data. The raw, unformatted output is provided below for manual review. This may indicate a temporary issue with the intelligence generation service.",
            professionalBackground: { category: "Professional Background", points: [] },
            recentActivities: { category: "Recent Activities & Online Presence", points: [] },
            personalInterests: { category: "Personal Interests & Hobbies", points: [] },
            discussionPoints: { category: "Potential Discussion Points", points: [] },
        };
    }
    
    // Include both the search results and the structured output for transparency
    report.rawText = `=== SEARCH RESULTS ===\n${searchText}\n\n=== STRUCTURED OUTPUT ===\n${structuredText}`;
    
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

        const text = (response as any).response?.text() || '{}';
        const data = JSON.parse(text);
        return { name: data.name || '', company: data.company || '' };

    } catch (error) {
        console.error("Error extracting text from image:", error);
        return { name: '', company: '' };
    }
};