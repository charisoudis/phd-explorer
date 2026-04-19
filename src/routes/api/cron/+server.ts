import { json } from '@sveltejs/kit';
import { Redis } from '@upstash/redis'; // Updated import
import { GoogleGenAI } from '@google/genai';
import OpenAI from 'openai';
import { OPENAI_API_KEY, GEMINI_API_KEY, UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, ADMIN_PASSCODE, CRON_SECRET } from '$env/static/private';

export const config = {
    maxDuration: 300
};

// Initialize Redis
const redis = new Redis({
    url: UPSTASH_REDIS_REST_URL,
    token: UPSTASH_REDIS_REST_TOKEN
});

const gemini = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

const UNIVERSITIES = 'ETHZ, EPFL, UZH, UniBasel, UniBern';
const RESEARCH_PROMPT = `Research open PhD placements at the following Swiss universities: ${UNIVERSITIES}. Find the job title, location, deadline, focus area, link, and a short description.`;

export async function GET({ request }) {
    // --- AUTHENTICATION CHECK ---
    const authHeader = request.headers.get('authorization');
    const providedToken = authHeader?.split(' ')[1]; // Extracts token from "Bearer <token>"

    // Get valid tokens (Admin passcode for UI, Cron Secret for Vercel's automated runs)
    const validTokens = [ADMIN_PASSCODE, CRON_SECRET].filter(Boolean);

    if (!providedToken || !validTokens.includes(providedToken)) {
        console.warn('Unauthorized attempt to trigger AI pipeline.');
        return json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }
    // -------------------------------

    let status = {
        isRunning: true,
        step1Gemini: 'loading',
        step1OpenAI: 'loading',
        step2Combine: 'pending',
        step3Parse: 'pending'
    };

    const updateStatus = async (updates: Partial<typeof status>) => {
        status = { ...status, ...updates };
        // Changed kv.set to redis.set
        await redis.set('phd_jobs_status', status);
    };

    try {
        await updateStatus({});

        // --- PHASE 1: Parallel Execution ---
        const [geminiRaw, openaiRaw] = await Promise.all([
            gemini.models.generateContent({
                model: 'gemini-deep-research-preview',
                contents: RESEARCH_PROMPT,
            }).then(async (res) => {
                await updateStatus({ step1Gemini: 'complete' });
                return res.text;
            }),
            openai.chat.completions.create({
                model: 'o3-mini',
                messages: [{ role: 'user', content: RESEARCH_PROMPT }]
            }).then(async (res) => {
                await updateStatus({ step1OpenAI: 'complete' });
                return res.choices[0].message.content;
            })
        ]);

        // --- PHASE 2: Combine & Validate ---
        await updateStatus({ step2Combine: 'loading' });

        const combinePrompt = `
            You have two raw research outputs regarding PhD placements at ${UNIVERSITIES}.
            Output 1 (Gemini): ${geminiRaw}
            Output 2 (OpenAI): ${openaiRaw}
            
            Merge these findings. Remove any duplicate listings. Strictly cross-validate and verify that the URLs provided look legitimate and belong to the respective university domains. Return the merged raw text.
        `;

        const combinedResult = await gemini.models.generateContent({
            model: 'gemini-3.1-pro',
            contents: combinePrompt
        });
        const combinedText = combinedResult.text || '';
        await updateStatus({ step2Combine: 'complete' });

        // --- PHASE 3: Structured Output ---
        await updateStatus({ step3Parse: 'loading' });

        const schema = {
            type: 'OBJECT',
            properties: {
                metadata: {
                    type: 'OBJECT',
                    properties: {
                        fetchDate: { type: 'STRING' },
                        prompt: { type: 'STRING' },
                        rawResponse: { type: 'STRING' }
                    },
                    required: ['fetchDate', 'prompt', 'rawResponse']
                },
                data: {
                    type: 'ARRAY',
                    items: {
                        type: 'OBJECT',
                        properties: {
                            id: { type: 'STRING' },
                            title: { type: 'STRING' },
                            university: { type: 'STRING' },
                            location: { type: 'STRING' },
                            deadline: { type: 'STRING' },
                            focus: { type: 'STRING' },
                            link: { type: 'STRING' },
                            desc: { type: 'STRING' }
                        },
                        required: ['id', 'title', 'university', 'location', 'deadline', 'focus', 'link', 'desc']
                    }
                }
            },
            required: ['metadata', 'data']
        };

        const finalParsing = await gemini.models.generateContent({
            model: 'gemini-3.1-pro',
            contents: `Parse the following merged PhD job data into the required JSON schema:\n\n${combinedText}`,
            config: {
                responseMimeType: 'application/json',
                responseSchema: schema as any
            }
        });

        const finalJsonString = finalParsing.text;
        if (finalJsonString) {
            const parsedData = JSON.parse(finalJsonString);

            parsedData.metadata.fetchDate = new Date().toISOString();
            parsedData.metadata.prompt = RESEARCH_PROMPT;
            parsedData.metadata.rawResponse = combinedText;

            // Changed kv.set to redis.set
            await redis.set('phd_jobs_data', parsedData);
        }

        await updateStatus({ step3Parse: 'complete', isRunning: false });
        return json({ success: true });

    } catch (error) {
        console.error('Pipeline Error:', error);
        await updateStatus({ isRunning: false });
        return json({ success: false, error: 'Pipeline failed' }, { status: 500 });
    }
}