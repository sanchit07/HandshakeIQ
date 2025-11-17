import {
  users,
  dossiers,
  notes,
  searchHistory,
  type User,
  type UpsertUser,
  type Dossier,
  type UpsertDossier,
  type Note,
  type UpsertNote,
  type SearchHistory,
  type UpsertSearchHistory,
} from "../shared/schema.js";
import { db } from "./db";
import { eq, desc, and, sql } from "drizzle-orm";

// Interface for storage operations
export interface IStorage {
  // User operations
  // (IMPORTANT) these user operations are mandatory for Replit Auth.
  getUser(id: string): Promise<User | undefined>;
  upsertUser(user: UpsertUser): Promise<User>;
  
  // Dossier operations
  saveDossier(dossier: UpsertDossier): Promise<Dossier>;
  getDossiersByUser(userId: string): Promise<Dossier[]>;
  getDossier(dossierId: string): Promise<Dossier | undefined>;
  updateDossier(dossierId: string, data: Partial<UpsertDossier>): Promise<Dossier>;
  deleteDossier(dossierId: string): Promise<void>;
  
  // Note operations
  addNote(note: UpsertNote): Promise<Note>;
  getNotesByDossier(dossierId: string): Promise<Note[]>;
  updateNote(noteId: string, content: string): Promise<Note>;
  deleteNote(noteId: string): Promise<void>;
  
  // Search History operations
  saveSearchHistory(searchData: UpsertSearchHistory): Promise<SearchHistory>;
  getSearchHistory(userId?: string, limit?: number): Promise<SearchHistory[]>;
  findExactMatch(personName: string, personCompany?: string, userId?: string): Promise<SearchHistory | undefined>;
  getRecentSearches(userId?: string, limit?: number): Promise<SearchHistory[]>;
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
  
  async saveDossier(dossierData: UpsertDossier): Promise<Dossier> {
    const [dossier] = await db
      .insert(dossiers)
      .values(dossierData)
      .returning();
    return dossier;
  }
  
  async getDossiersByUser(userId: string): Promise<Dossier[]> {
    return await db
      .select()
      .from(dossiers)
      .where(eq(dossiers.userId, userId))
      .orderBy(desc(dossiers.updatedAt));
  }
  
  async getDossier(dossierId: string): Promise<Dossier | undefined> {
    const [dossier] = await db
      .select()
      .from(dossiers)
      .where(eq(dossiers.id, dossierId));
    return dossier;
  }
  
  async updateDossier(dossierId: string, data: Partial<UpsertDossier>): Promise<Dossier> {
    const [dossier] = await db
      .update(dossiers)
      .set({
        ...data,
        updatedAt: new Date(),
      })
      .where(eq(dossiers.id, dossierId))
      .returning();
    return dossier;
  }
  
  async deleteDossier(dossierId: string): Promise<void> {
    await db.delete(dossiers).where(eq(dossiers.id, dossierId));
  }
  
  // Note operations
  
  async addNote(noteData: UpsertNote): Promise<Note> {
    const [note] = await db
      .insert(notes)
      .values(noteData)
      .returning();
    return note;
  }
  
  async getNotesByDossier(dossierId: string): Promise<Note[]> {
    return await db
      .select()
      .from(notes)
      .where(eq(notes.dossierId, dossierId))
      .orderBy(desc(notes.createdAt));
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
    await db.delete(notes).where(eq(notes.id, noteId));
  }
  
  // Search History operations
  
  async saveSearchHistory(searchData: UpsertSearchHistory): Promise<SearchHistory> {
    const [search] = await db
      .insert(searchHistory)
      .values(searchData)
      .returning();
    return search;
  }
  
  async getSearchHistory(userId?: string, limit: number = 50): Promise<SearchHistory[]> {
    if (userId) {
      return await db
        .select()
        .from(searchHistory)
        .where(eq(searchHistory.userId, userId))
        .orderBy(desc(searchHistory.searchedAt))
        .limit(limit);
    } else {
      return await db
        .select()
        .from(searchHistory)
        .where(sql`${searchHistory.userId} IS NULL`)
        .orderBy(desc(searchHistory.searchedAt))
        .limit(limit);
    }
  }
  
  async findExactMatch(personName: string, personCompany?: string, userId?: string): Promise<SearchHistory | undefined> {
    const conditions = [
      sql`LOWER(${searchHistory.personName}) = LOWER(${personName})`
    ];
    
    if (personCompany) {
      conditions.push(sql`LOWER(${searchHistory.personCompany}) = LOWER(${personCompany})`);
    }
    
    if (userId) {
      conditions.push(eq(searchHistory.userId, userId));
    } else {
      conditions.push(sql`${searchHistory.userId} IS NULL`);
    }
    
    const [match] = await db
      .select()
      .from(searchHistory)
      .where(and(...conditions))
      .orderBy(desc(searchHistory.searchedAt))
      .limit(1);
    
    return match;
  }
  
  async getRecentSearches(userId?: string, limit: number = 10): Promise<SearchHistory[]> {
    return this.getSearchHistory(userId, limit);
  }
}

export const storage = new DatabaseStorage();
