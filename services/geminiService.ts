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
    
    console.log(`[GEMINI API] Step 1: Searching for information about "${personName}" at "${company}"`);
    
    const searchResponse: GenerateContentResponse = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: [{ role: "user", parts: [{ text: searchPrompt }] }],
        config: {
            tools: [{ googleSearch: {} }]
        }
    });

    console.log(`[GEMINI API] Step 1 Response Status:`, {
      hasResponse: !!(searchResponse as any).response,
      hasCandidates: !!(searchResponse as any).response?.candidates,
      candidatesLength: (searchResponse as any).response?.candidates?.length || 0
    });

    const searchText = (searchResponse as any).response?.text() || '';
    const sources = (searchResponse as any).response?.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
    
    console.log(`[GEMINI API] Step 1: Retrieved ${sources.length} sources for ${personName}`);
    console.log(`[GEMINI API] Step 1: Search text length: ${searchText.length} characters`);
    
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
    
    console.log(`[GEMINI API] Step 2: Structuring intelligence report for ${personName}`);
    
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

    console.log(`[GEMINI API] Step 2 Response Status:`, {
      hasResponse: !!(structureResponse as any).response,
      hasCandidates: !!(structureResponse as any).response?.candidates,
      candidatesLength: (structureResponse as any).response?.candidates?.length || 0
    });

    const structuredText = (structureResponse as any).response?.text() || '';
    console.log(`[GEMINI API] Step 2: Structured text length: ${structuredText.length} characters`);

    let report: IntelligenceReport;
    
    try {
        if (!structuredText || structuredText.trim() === '') {
            throw new Error('Empty response from Gemini API');
        }
        
        report = JSON.parse(structuredText);
        
        if (!report.summary || !report.professionalBackground || !report.recentActivities || 
            !report.personalInterests || !report.discussionPoints) {
            throw new Error('Missing required fields in parsed response');
        }
        
        console.log(`[GEMINI API] Step 2: Successfully structured intelligence report for ${personName} with ${sources.length} sources`);
        console.log(`[GEMINI API] Report structure:`, {
          hasSummary: !!report.summary,
          professionalBackgroundPoints: report.professionalBackground.points.length,
          recentActivitiesPoints: report.recentActivities.points.length,
          personalInterestsPoints: report.personalInterests.points.length,
          discussionPointsPoints: report.discussionPoints.points.length
        });
    } catch (parseError) {
        console.error("[GEMINI API ERROR] Failed to parse structured JSON response:", {
          error: parseError instanceof Error ? parseError.message : String(parseError),
          rawTextPreview: structuredText.substring(0, 500),
          rawTextLength: structuredText.length
        });
        
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
    console.error("[GEMINI API ERROR] Error generating intelligence report:", {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      personName,
      company
    });
    
    let errorMessage = "A critical error occurred while communicating with the intelligence network.";
    
    if (error instanceof Error) {
      if (error.message.includes('429') || error.message.toLowerCase().includes('rate limit')) {
        errorMessage = "Rate limit exceeded. The API has received too many requests. Please wait a moment and try again.";
      } else if (error.message.includes('401') || error.message.toLowerCase().includes('unauthorized')) {
        errorMessage = "Authentication failed. The API key may be invalid or expired. Please check your Gemini API key configuration.";
      } else if (error.message.includes('403') || error.message.toLowerCase().includes('forbidden')) {
        errorMessage = "Access forbidden. The API key may not have permission to use Google Search grounding or this model.";
      } else if (error.message.includes('500') || error.message.toLowerCase().includes('internal server')) {
        errorMessage = "Gemini API server error. This is a temporary issue on Google's side. Please try again in a few moments.";
      } else if (error.message.toLowerCase().includes('network') || error.message.toLowerCase().includes('fetch')) {
        errorMessage = "Network connection error. Please check your internet connection and try again.";
      }
    }
    
    const errorReport: IntelligenceReport = {
        summary: errorMessage,
        professionalBackground: { category: "Professional Background", points: [] },
        recentActivities: { category: "Recent Activities & Online Presence", points: [] },
        personalInterests: { category: "Personal Interests & Hobbies", points: [] },
        discussionPoints: { category: "Potential Discussion Points", points: [] },
        rawText: error instanceof Error ? `${error.message}\n\nStack: ${error.stack}` : String(error)
    };
    return { report: errorReport, sources: [] };
  }
};

export const extractTextFromImage = async (base64Image: string): Promise<{name: string, company: string}> => {
    try {
        console.log('[GEMINI API] Extracting text from business card image');
        
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
        console.log('[GEMINI API] Business card extraction response length:', text.length);
        
        const data = JSON.parse(text);
        console.log('[GEMINI API] Successfully extracted:', { name: data.name || 'N/A', company: data.company || 'N/A' });
        
        return { name: data.name || '', company: data.company || '' };

    } catch (error) {
        console.error("[GEMINI API ERROR] Error extracting text from image:", {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined
        });
        return { name: '', company: '' };
    }
};