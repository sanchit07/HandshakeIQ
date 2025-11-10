import {
  users,
  dossiers,
  notes,
  type User,
  type UpsertUser,
  type Dossier,
  type UpsertDossier,
  type Note,
  type UpsertNote,
} from "../shared/schema.js";
import { db } from "./db";
import { eq, desc } from "drizzle-orm";

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
}

export const storage = new DatabaseStorage();
