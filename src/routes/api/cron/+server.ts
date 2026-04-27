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

const UNIVERSITIES = 'ETHZ, EPFL, UZH, UniBasel, UniBern, UniGeneva';

// IMPROVED PROMPT: Strict focus on URL validity
const RESEARCH_PROMPT = `
    Find open PhD positions (100% employment) at ${UNIVERSITIES}. 
    Focus: Computer Vision, 3D Vision, Foundation Models, or Robotics.
    
    CRITICAL INSTRUCTION FOR LINKS: 
    For every position, you MUST provide the DIRECT PERMANENT LINK to the university's internal recruitment portal (e.g., jobs.ethz.ch, epfl.ch/about/working, etc.). 
    DO NOT provide search result URLs, truncated links, or homepages. 
    If you cannot find the direct job post URL, do not include the position.
`;

export async function GET({ request }) {
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

        const [geminiResult, openaiRaw] = await Promise.all([
            (async () => {
                let current = await ai.interactions.create({
                    input: RESEARCH_PROMPT,
                    agent: "deep-research-preview-04-2026",
                    background: true
                });

                while (current.status !== "completed") {
                    if (current.status === "failed") throw new Error(`Gemini Agent Failed: ${(current as any).error}`);
                    await new Promise(r => setTimeout(r, 10000));
                    current = await ai.interactions.get(current.id);
                }
                await updateStatus({ step1Gemini: 'complete' });
                const outputs = current.outputs || [];
                const finalOutput = outputs[outputs.length - 1];
                return (finalOutput as any).text;
            })(),

            openai.chat.completions.create({
                model: 'o3-mini',
                messages: [{ role: 'user', content: RESEARCH_PROMPT }]
            }).then(async (res) => {
                await updateStatus({ step1OpenAI: 'complete' });
                return res.choices[0].message.content || "";
            })
        ]);

        // --- PHASE 2: Strict Validation & Merging ---
        await updateStatus({ step2Combine: 'loading' });

        const combinePrompt = `
            You are a data validator. Merge these two PhD research outputs:
            Output 1: ${geminiResult}
            Output 2: ${openaiRaw}

            STRICT LINK VALIDATION RULES:
            1. Every link must be a full URL (starting with https://).
            2. DISCARD any listing where the link looks like a search snippet (ends in "..." or is clearly incomplete).
            3. DISCARD any listing where the link is just the general university homepage.
            4. DISCARD any listing where the link returns a 404 in your simulation or looks "guessed" (e.g., jobid=xyz).
            5. Ensure the links point directly to portals like jobs.ethz.ch, recruiting.uzh.ch, or similar.
            
            Return the merged, validated list in plain text.
        `;

        const mergeRes = await ai.models.generateContent({
            model: "gemini-3.1-pro-preview",
            contents: [{ role: 'user', parts: [{ text: combinePrompt }] }]
        });

        const combinedText = (mergeRes as any).text || "";
        await updateStatus({ step2Combine: 'complete' });

        // --- PHASE 3: Structured Output ---
        await updateStatus({ step3Parse: 'loading' });

        const schema = {
            type: 'object',
            properties: {
                metadata: { type: 'object', properties: { fetchDate: { type: 'string' } }, required: ['fetchDate'] },
                data: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            id: { type: 'string' },
                            title: { type: 'string' },
                            university: { type: 'string' },
                            location: { type: 'string' },
                            deadline: { type: 'string' },
                            focus: { type: 'string' },
                            link: { type: 'string' },
                            desc: { type: 'string' }
                        },
                        required: ['id', 'title', 'university', 'location', 'deadline', 'focus', 'link', 'desc']
                    }
                }
            },
            required: ['metadata', 'data']
        };

        const finalParsing = await ai.models.generateContent({
            model: "gemini-3-flash-preview",
            contents: [{ role: 'user', parts: [{ text: `Convert this into JSON. If a link looks broken or suspicious, do not include the item: ${combinedText}` }] }],
            config: { responseMimeType: "application/json", responseSchema: schema as any }
        });

        const jsonText = (finalParsing as any).text;
        if (jsonText) {
            const parsedData = JSON.parse(jsonText);
            parsedData.metadata.fetchDate = new Date().toISOString();
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