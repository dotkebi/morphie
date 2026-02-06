import path from 'path';
import { FileSystem } from './filesystem.js';

export interface PortingSession {
  version: number;
  sourcePath: string;
  targetPath: string;
  sourceLanguage: string;
  targetLanguage: string;
  model?: string;
  startedAt: string;
  updatedAt: string;
  phase: 'analysis' | 'porting' | 'verification' | 'completed' | 'failed';
  taskUnderstanding?: {
    projectType: string;
    challenges: string[];
    criticalFeatures: string[];
    risks: string[];
    recommendedStrategy: string;
    complexity: 'low' | 'medium' | 'high';
  };
  analysis?: {
    files: number;
    entryPoints: string[];
    dependencies: string[];
    structure: {
      hasTests: boolean;
      hasConfig: boolean;
      hasDocs: boolean;
      directories: string[];
    };
  };
  totalFiles?: number;
  completedFiles: string[];
  failedFiles: Array<{ file: string; error: string }>;
}

export class SessionManager {
  private fs: FileSystem;

  constructor() {
    this.fs = new FileSystem();
  }

  async load(sessionPath: string): Promise<PortingSession | null> {
    if (!(await this.fs.fileExists(sessionPath))) {
      return null;
    }
    const raw = await this.fs.readFile(sessionPath);
    return JSON.parse(raw) as PortingSession;
  }

  async save(sessionPath: string, session: PortingSession): Promise<void> {
    session.updatedAt = new Date().toISOString();
    await this.fs.ensureDirectory(path.dirname(sessionPath));
    await this.fs.writeFile(sessionPath, JSON.stringify(session, null, 2));
  }

  createInitial(
    sourcePath: string,
    targetPath: string,
    sourceLanguage: string,
    targetLanguage: string,
    model?: string
  ): PortingSession {
    const now = new Date().toISOString();
    return {
      version: 1,
      sourcePath,
      targetPath,
      sourceLanguage,
      targetLanguage,
      model,
      startedAt: now,
      updatedAt: now,
      phase: 'analysis',
      completedFiles: [],
      failedFiles: [],
    };
  }
}
