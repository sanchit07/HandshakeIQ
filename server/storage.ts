import {
  users,
  type User,
  type UpsertUser,
  savedDossiers,
  type SavedDossier,
  type InsertSavedDossier,
  notes,
  type Note,
  type InsertNote,
} from "../shared/schema.js";
import { db } from "./db";
import { eq } from "drizzle-orm";
import type { IntelligenceReport } from "../types";

// Interface for storage operations
export interface IStorage {
  // User operations
  // (IMPORTANT) these user operations are mandatory for Replit Auth.
  getUser(id: string): Promise<User | undefined>;
  upsertUser(user: UpsertUser): Promise<User>;
  
  // Dossier operations
  saveDossier(userId: string, person: { name: string; title?: string; company?: string; email?: string; photoUrl?: string; linkedInUrl?: string }, report: IntelligenceReport, sources?: string[]): Promise<SavedDossier>;
  getDossiers(userId: string): Promise<SavedDossier[]>;
  getDossier(dossierId: string): Promise<SavedDossier | undefined>;
  
  // Note operations
  saveNote(dossierId: string, userId: string, content: string): Promise<Note>;
  getNotes(dossierId: string): Promise<Note[]>;
  updateNote(noteId: string, content: string): Promise<Note>;
  deleteNote(noteId: string): Promise<void>;
}

export class DatabaseStorage implements IStorage {
  // User operations
  // (IMPORTANT) these user operations are mandatory for Replit Auth.

  async getUser(id: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user;
  }

  async upsertUser(userData: UpsertUser): Promise<User> {
    const [user] = await db
      .insert(users)
      .values(userData)
      .onConflictDoUpdate({
        target: users.id,
        set: {
          ...userData,
          updatedAt: new Date(),
        },
      })
      .returning();
    return user;
  }

  // Dossier operations
  async saveDossier(
    userId: string, 
    person: { name: string; title?: string; company?: string; email?: string; photoUrl?: string; linkedInUrl?: string }, 
    report: IntelligenceReport, 
    sources?: string[]
  ): Promise<SavedDossier> {
    const [dossier] = await db
      .insert(savedDossiers)
      .values({
        userId,
        personName: person.name,
        personTitle: person.title,
        personCompany: person.company,
        personEmail: person.email,
        personPhotoUrl: person.photoUrl,
        personLinkedInUrl: person.linkedInUrl,
        intelligenceReport: report,
        allLinks: sources || [],
      })
      .returning();
    return dossier;
  }

  async getDossiers(userId: string): Promise<SavedDossier[]> {
    const dossiers = await db
      .select()
      .from(savedDossiers)
      .where(eq(savedDossiers.userId, userId));
    return dossiers;
  }

  async getDossier(dossierId: string): Promise<SavedDossier | undefined> {
    const [dossier] = await db
      .select()
      .from(savedDossiers)
      .where(eq(savedDossiers.id, dossierId));
    return dossier;
  }

  // Note operations
  async saveNote(dossierId: string, userId: string, content: string): Promise<Note> {
    const [note] = await db
      .insert(notes)
      .values({
        dossierId,
        userId,
        content,
      })
      .returning();
    return note;
  }

  async getNotes(dossierId: string): Promise<Note[]> {
    const allNotes = await db
      .select()
      .from(notes)
      .where(eq(notes.dossierId, dossierId));
    return allNotes;
  }

  async updateNote(noteId: string, content: string): Promise<Note> {
    const [note] = await db
      .update(notes)
      .set({
        content,
        updatedAt: new Date(),
      })
      .where(eq(notes.id, noteId))
      .returning();
    return note;
  }

  async deleteNote(noteId: string): Promise<void> {
    await db
      .delete(notes)
      .where(eq(notes.id, noteId));
  }
}

export const storage = new DatabaseStorage();
