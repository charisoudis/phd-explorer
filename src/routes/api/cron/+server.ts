import { json } from '@sveltejs/kit';
import { Redis } from '@upstash/redis';
import { GoogleGenAI } from '@google/genai';
import OpenAI from 'openai';
import {
    OPENAI_API_KEY,
    GEMINI_API_KEY,
    UPSTASH_REDIS_REST_URL,
    UPSTASH_REDIS_REST_TOKEN,
    ADMIN_PASSCODE
} from '$env/static/private';
import { env } from '$env/dynamic/private';

export const config = {
    maxDuration: 300
};

const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

const UNIVERSITIES = 'ETHZ, EPFL, UZH, UniBasel, UniBern';
const RESEARCH_PROMPT = `Research open 100% PhD placements at the following Swiss universities: ${UNIVERSITIES}. Focus on Computer Vision, 3D Vision, and Foundation Models. Find the job title, university, location, deadline, focus area, link, and a short description.`;

export async function GET({ request }) {
    // --- 1. AUTHENTICATION ---
    const authHeader = request.headers.get('authorization');
    const providedToken = authHeader?.split(' ')[1];
    const validTokens = [ADMIN_PASSCODE, env.CRON_SECRET].filter(Boolean);
    if (!providedToken || !validTokens.includes(providedToken)) return json({ error: 'Unauthorized' }, { status: 401 });

    let status = { isRunning: true, step1Gemini: 'loading', step1OpenAI: 'loading', step2Combine: 'pending', step3Parse: 'pending' };
    const updateStatus = async (updates: Partial<typeof status>) => {
        status = { ...status, ...updates };
        await redis.set('phd_jobs_status', status);
    };

    try {
        await updateStatus({});

        // --- PHASE 1: Parallel Research ---
        const [geminiResult, openaiRaw] = await Promise.all([
            // Task A: Gemini Deep Research Agent
            (async () => {
                let current = await ai.interactions.create({
                    input: RESEARCH_PROMPT,
                    agent: "deep-research-preview-04-2026",
                    background: true
                });

                while (current.status !== "completed") {
                    if (current.status === "failed") {
                        // Cast to any to access error property which may be missing in the type def
                        const errorMsg = (current as any).error || "Unknown Agent Error";
                        throw new Error(`Gemini Agent Failed: ${errorMsg}`);
                    }
                    await new Promise(r => setTimeout(r, 10000));
                    current = await ai.interactions.get(current.id);
                }

                await updateStatus({ step1Gemini: 'complete' });

                // Check if outputs exist to satisfy TS18048
                if (current.outputs && current.outputs.length > 0) {
                    const finalOutput = current.outputs[current.outputs.length - 1];
                    // Verify that the output has text (handling multimodal response types)
                    if (typeof finalOutput === 'object' && 'text' in finalOutput) {
                        return (finalOutput as { text: string }).text;
                    }
                }
                throw new Error("Gemini Agent completed but returned no text results.");
            })(),

            // Task B: OpenAI o3-mini
            openai.chat.completions.create({
                model: 'o3-mini',
                messages: [{ role: 'user', content: RESEARCH_PROMPT }]
            }).then(async (res) => {
                await updateStatus({ step1OpenAI: 'complete' });
                return res.choices[0].message.content || "";
            })
        ]);

        // --- PHASE 2: Combine & Validate ---
        await updateStatus({ step2Combine: 'loading' });

        const mergeRes = await ai.models.generateContent({
            model: "gemini-3.1-pro-preview",
            contents: [{ role: 'user', parts: [{ text: `Merge and cross-validate these PhD listings for Switzerland. Remove duplicates. Output 1: ${geminiResult} Output 2: ${openaiRaw}` }] }]
        });

        // Use type-casting to access .text if the Content_2 type is being difficult
        const combinedText = (mergeRes as any).text || "";
        await updateStatus({ step2Combine: 'complete' });

        // --- PHASE 3: Structured Output ---
        await updateStatus({ step3Parse: 'loading' });

        const schema = {
            type: 'object',
            properties: {
                metadata: { type: 'object', properties: { fetchDate: { type: 'string' }, prompt: { type: 'string' }, rawResponse: { type: 'string' } }, required: ['fetchDate', 'prompt', 'rawResponse'] },
                data: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' }, university: { type: 'string' }, location: { type: 'string' }, deadline: { type: 'string' }, focus: { type: 'string' }, link: { type: 'string' }, desc: { type: 'string' } }, required: ['id', 'title', 'university', 'location', 'deadline', 'focus', 'link', 'desc'] } }
            },
            required: ['metadata', 'data']
        };

        const finalParsing = await ai.models.generateContent({
            model: "gemini-3-flash-preview",
            contents: [{ role: 'user', parts: [{ text: `Format this as JSON based on the schema: ${combinedText}` }] }],
            config: {
                responseMimeType: "application/json",
                responseSchema: schema as any
            }
        });

        const jsonText = (finalParsing as any).text;
        if (jsonText) {
            const parsedData = JSON.parse(jsonText);
            parsedData.metadata.fetchDate = new Date().toISOString();
            parsedData.metadata.prompt = RESEARCH_PROMPT;
            parsedData.metadata.rawResponse = combinedText;
            await redis.set('phd_jobs_data', parsedData);
        }

        await updateStatus({ step3Parse: 'complete', isRunning: false });
        return json({ success: true });

    } catch (error: any) {
        console.error('Pipeline Error:', error);
        await updateStatus({ isRunning: false });
        return json({ success: false, error: error.message }, { status: 500 });
    }
}