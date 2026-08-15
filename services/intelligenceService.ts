import { IntelligenceReport } from '../types';
import { generateIntelligenceReportClaude, extractTextFromImageClaude } from './anthropicService';
import { generateIntelligenceReport as generateIntelligenceReportGemini, extractTextFromImage as extractTextFromImageGemini } from './geminiService';

// Anthropic (Claude) is the primary provider; Gemini is the fallback.

export const generateIntelligenceReport = async (
  personName: string,
  company: string,
  additionalLinks?: string[]
): Promise<{ report: IntelligenceReport; sources: any[] }> => {
  try {
    return await generateIntelligenceReportClaude(personName, company, additionalLinks);
  } catch (error) {
    console.error('[INTELLIGENCE] Claude failed, falling back to Gemini:', error instanceof Error ? error.message : error);
    return await generateIntelligenceReportGemini(personName, company, additionalLinks);
  }
};

export const extractTextFromImage = async (
  base64Image: string
): Promise<{ name: string; company: string }> => {
  try {
    return await extractTextFromImageClaude(base64Image);
  } catch (error) {
    console.error('[INTELLIGENCE] Claude card extraction failed, falling back to Gemini:', error instanceof Error ? error.message : error);
    return await extractTextFromImageGemini(base64Image);
  }
};
