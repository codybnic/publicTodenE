import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { spawn } from 'child_process';

// FIX: Define a specific type for the Python script's output instead of 'any'.
interface PythonScriptOutput {
  error?: string;
  result?: unknown; // Use 'unknown' for nested data whose structure isn't strictly defined here.
}

const LOCAL_PROJECT_TMP_BASE = path.join(process.cwd(), 'tmp');
const IS_VERCEL_ENV = !!process.env.VERCEL_ENV;

const NODE_TEMP_STORAGE_BASE = IS_VERCEL_ENV
  ? '/tmpx'
  : LOCAL_PROJECT_TMP_BASE;

const PYTHON_TARGET_TMP_BASE = IS_VERCEL_ENV
  ? '/tmp'
  : LOCAL_PROJECT_TMP_BASE;

const TTL_MS = 30 * 60 * 1000;

async function ensureDir(dirPath: string) {
  try {
    await fs.mkdir(dirPath, { recursive: true });
    // FIX (Error on line 29): The 'error' variable is not used, so it can be removed from the catch clause.
  } catch {
    // This is a warning, so we can ignore the error object if we don't need to inspect it.
    console.warn(`Could not create directory: ${dirPath}`);
  }
}

async function ensureBaseTempDirectories() {
  await ensureDir(NODE_TEMP_STORAGE_BASE);
  if (PYTHON_TARGET_TMP_BASE !== NODE_TEMP_STORAGE_BASE) {
    await ensureDir(PYTHON_TARGET_TMP_BASE);
  }
}

function runPythonPredictScript(
  pagsTxtPath: string,
  alpha: string,
  clusters: string,
  resultId: string
): Promise<PythonScriptOutput> { // FIX (Error on line 41): Use the specific type.
  return new Promise((resolve, reject) => {
    const pythonExecutable = 'python3';
    const pythonScriptPath = path.join(process.cwd(), 'python_scripts', 'runner.py');
    const scriptArgs = [pythonScriptPath, pagsTxtPath, alpha, clusters, resultId, PYTHON_TARGET_TMP_BASE];

    console.log(`Executing: ${pythonExecutable} ${scriptArgs.map(arg => `"${arg}"`).join(' ')}`);
    const pythonProcess = spawn(pythonExecutable, scriptArgs);
    let stdoutData = '';
    let stderrData = '';

    pythonProcess.stdout.on('data', (data) => { stdoutData += data.toString(); });
    pythonProcess.stderr.on('data', (data) => { stderrData += data.toString(); });

    pythonProcess.on('close', (code) => {
      if (stderrData) {
        console.error(`Python script stderr: ${stderrData}`);
      }
      if (code !== 0 && !stdoutData.trim()) {
        return reject(new Error(`Python script exited with code ${code}. Stderr: ${stderrData.trim()}`));
      }
      try {
        const lines = stdoutData.trim().split('\n');
        const lastLine = lines[lines.length - 1];
        const result = JSON.parse(lastLine);

        if (result.error) {
          console.warn('Python script reported an error in JSON:', result);
          return reject(result);
        }
        resolve(result);
      } catch (parseError) {
        console.error('Failed to parse Python script output:', parseError, `Raw stdout: [${stdoutData}]`);
        reject(new Error(`Failed to parse Python script output. Ensure Python ONLY prints JSON to stdout. Output: ${stdoutData.trim()}`));
      }
    });
    // FIX (Error on line 84): Disable the ESLint rule for this line since '_err' is intentionally unused.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    pythonProcess.on('error', (_err) => { /* ... */ });
  });
}

function splitCSV(line: string): string[] {
  return line.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/);
}

function extractNodesFromTodenEClusterCSV(fileContent: string): Set<string> {
  const nodesSet = new Set<string>();
  const lines = fileContent.split('\n').filter(line => line.trim() !== '');
  
  const i_start = 1;
  for (let i = i_start; i < lines.length; i++) {
    const cols = splitCSV(lines[i]);
    const j_start = 1; 
    for (let j = j_start; j < cols.length; j++) {
      const cleaned = cols[j].replace(/"/g, ''); 
      const tokens = cleaned.split(',').map(s => s.trim()).filter(Boolean);
      tokens.forEach(n => nodesSet.add(n));
    }
  }
  console.log("extractNodesFromTodenEClusterCSV extracted nodesSet size:", nodesSet.size);
  if (nodesSet.size > 0) {
      console.log("extractNodesFromTodenEClusterCSV sample extracted nodes:", Array.from(nodesSet).slice(0, 5));
  }
  return nodesSet;
}

async function generateMTypeRelatedDataFile(
  sourceTodenEClusterCsvPath: string,
  hugeBioProcessFilePath: string,
  outputCsvFilePath: string
) {
  let sourceFileContent;
  try {
    sourceFileContent = await fs.readFile(sourceTodenEClusterCsvPath, 'utf8');
  } catch (error) {
    console.error(`generateMTypeRelatedDataFile: Source Toden-E cluster CSV file not found at ${sourceTodenEClusterCsvPath}`, error);
    throw new Error(`Source Toden-E cluster CSV file for M-Type data not found: ${sourceTodenEClusterCsvPath}`);
  }

  
  const nodesSet = extractNodesFromTodenEClusterCSV(sourceFileContent);
  const allowedNodes = Array.from(nodesSet).sort();

  const headerLine = 'GS_A_ID,GS_B_ID,SIMILARITY\n';

  if (allowedNodes.length === 0) {
    console.warn(`generateMTypeRelatedDataFile: No allowed nodes extracted from ${sourceTodenEClusterCsvPath}. Output file will be empty (headers only).`);
    await fs.writeFile(outputCsvFilePath, headerLine, 'utf8');
    console.log(`generateMTypeRelatedDataFile: Empty M-Type data file (headers only) written to ${outputCsvFilePath}`);
    return { allowedNodesCount: 0, resultsCount: 0 };
  }

  let hugeContent;
  try {
    hugeContent = await fs.readFile(hugeBioProcessFilePath, 'utf8');
  } catch (error) {
    console.error(`generateMTypeRelatedDataFile: Huge bioprocess file not found at ${hugeBioProcessFilePath}`, error);
    throw new Error(`Huge bioprocess file not found: ${hugeBioProcessFilePath}`);
  }
  
  const hugeLines = hugeContent.split('\n').filter(line => line.trim() !== '');
  const results = [];

  for (let i = 1; i < hugeLines.length; i++) { 
    const cols = hugeLines[i].split('\t'); 
    if (cols.length < 7) continue;

    if (nodesSet.has(cols[0]) && nodesSet.has(cols[1])) {
      results.push({
        GS_A_ID: cols[0],
        GS_B_ID: cols[1],
        SIMILARITY: cols[6]
      });
    }
  }
  
  const csvLines = results.map(r => `${r.GS_A_ID},${r.GS_B_ID},${r.SIMILARITY}`).join('\n');
  
  const outputDir = path.dirname(outputCsvFilePath);
  await ensureDir(outputDir);

  await fs.writeFile(outputCsvFilePath, headerLine + csvLines, 'utf8');
  console.log(`generateMTypeRelatedDataFile: M-Type data file with ${results.length} records written to ${outputCsvFilePath}`);
  return { allowedNodesCount: allowedNodes.length, resultsCount: results.length };
}

export async function POST(request: NextRequest) {
  await ensureBaseTempDirectories();

  let tempUploadedInputFilePath: string | null = null;
  const resultId = uuidv4();

  try {
    const formData = await request.formData();
    const fileUpload = formData.get('fileUpload') as File | null;
    const selectedFileBaseName = formData.get('file') as string | null;
    const alpha = formData.get('alpha') as string;
    const clusters = formData.get('clusters') as string;

    if (!alpha || !clusters) { /* ... error ... */ }
    if (Number.isNaN(parseFloat(alpha)) || Number.isNaN(parseInt(clusters))) { /* ... error ... */ }

    let pagsTxtPathForPython: string;
    let inputIdentifierForResults: string;

    if (fileUpload) {
      inputIdentifierForResults = fileUpload.name;
      
      const uniqueFilename = `${resultId}_input_${fileUpload.name.replace(/[^a-zA-Z0-9_.-]/g, '_')}`;
      tempUploadedInputFilePath = path.join(NODE_TEMP_STORAGE_BASE, uniqueFilename);
      const fileBuffer = Buffer.from(await fileUpload.arrayBuffer());
      await fs.writeFile(tempUploadedInputFilePath, fileBuffer);
      pagsTxtPathForPython = tempUploadedInputFilePath;
      console.log(`Uploaded file "${fileUpload.name}" saved to: ${pagsTxtPathForPython}`);
    } 
    else if (selectedFileBaseName) {
      inputIdentifierForResults = `${selectedFileBaseName}.txt`;
      pagsTxtPathForPython = path.join(process.cwd(), 'python_scripts', 'data', `${selectedFileBaseName}.txt`);
      console.log(`Using predefined file: ${pagsTxtPathForPython}`);
      // FIX (Error on line 199): Remove the unused 'e' variable from the catch block.
      try { await fs.access(pagsTxtPathForPython); } catch { return NextResponse.json({ error: `Selected data file "${inputIdentifierForResults}" not found on server.` }, { status: 404 });}
    } 
    else {
      return NextResponse.json({ error: 'No file provided.' }, { status: 400 });
    }

    console.log(`Invoking Toden-E Python script with: path=${pagsTxtPathForPython}, alpha=${alpha}, clusters=${clusters}, resultId=${resultId}, python_base_tmp=${PYTHON_TARGET_TMP_BASE}`);
    const pythonOutput = await runPythonPredictScript(pagsTxtPathForPython, alpha, clusters, resultId);

    if (pythonOutput.error) { }
    const mTypeHugeFilePath = path.join(process.cwd(), 'go_metadata', 'm_type_biological_process.txt');

    const sourceTodenEClusterCsvPath = path.join(PYTHON_TARGET_TMP_BASE, 'toden_e_py_outputs', `${resultId}`, `clusters_${resultId}.csv`);
    const mTypeOutputCsvPath = path.join(PYTHON_TARGET_TMP_BASE, 'toden_e_py_outputs', resultId, `data_${resultId}.csv`);
    
    let mTypeGenerationStats: { allowedNodesCount: number; resultsCount: number } | null = null;
    // FIX (Error on line 222): Change 'any' to 'unknown' and safely check the error type.
    try {
      mTypeGenerationStats = await generateMTypeRelatedDataFile(
        sourceTodenEClusterCsvPath,
        mTypeHugeFilePath,
        mTypeOutputCsvPath
      );
      console.log(`M-Type related data generation for resultId ${resultId} completed. Stats:`, mTypeGenerationStats);
    } catch (mTypeError: unknown) {
      if (mTypeError instanceof Error) {
        console.error(`Failed to generate M-Type related data for resultId ${resultId}:`, mTypeError.message);
      } else {
        console.error(`An unknown error occurred while generating M-Type data for resultId ${resultId}`);
      }
    }

    const actualPredictionData = pythonOutput.result;
    const expiresAt = Date.now() + TTL_MS;
    const finalResultFilePath = path.join(NODE_TEMP_STORAGE_BASE, `${resultId}.json`);

    const responsePayloadToStoreAndSend = {
      id: resultId,
      requestedInput: inputIdentifierForResults,
      params: { alpha, clusters },
      prediction: actualPredictionData,
      mTypeDataGeneration: mTypeGenerationStats ? 
        { status: 'success', path: `toden_e_py_outputs/${resultId}/data_${resultId}.csv`, ...mTypeGenerationStats } :
        { status: 'failed_or_skipped', path: null },
      generatedAt: new Date().toISOString(),
      expiresAtIso: new Date(expiresAt).toISOString(),
    };

    await fs.writeFile(finalResultFilePath, JSON.stringify(responsePayloadToStoreAndSend, null, 2));
    console.log(`Main result metadata (ID: ${resultId}) stored at: ${finalResultFilePath}`);

    return NextResponse.json({ success: true, resultId: resultId, result: actualPredictionData });

  } catch (error: unknown) { // FIX (Errors on line 247): Change 'any' to 'unknown' and add proper error handling.
    console.error("An error occurred in the predict API route:", error);
    return NextResponse.json({ success: false, error: "An internal server error occurred." }, { status: 500 });
  }
  finally { /* ... cleanup tempUploadedInputFilePath ... */ }
}