import { NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const id = body.id;

    if (!id || typeof id !== 'string' || id.trim() === '') {
      return NextResponse.json({ isValid: false, message: 'ID is required.' }, { status: 400 });
    }

    if (id.includes('/') || id.includes('..')) {
      return NextResponse.json({ isValid: false, message: 'Invalid ID format.' }, { status: 400 });
    }

    const projectRoot = process.cwd();
    const tempDirPath = path.join(projectRoot, 'tmp');
    const targetFilename = `${id}.json`;
    const targetPath = path.join(tempDirPath, targetFilename);

    try {
      await fs.access(targetPath);
      return NextResponse.json({ isValid: true });
      // FIX (Error on line 26): The 'error' variable is not used, so it can be removed.
    } catch {
      return NextResponse.json({ isValid: false });
    }
    // FIX (Error on line 29): This 'error' variable is also not used and can be removed.
  } catch {
    return NextResponse.json({ isValid: false, message: 'Error processing request.' }, { status: 500 });
  }
}