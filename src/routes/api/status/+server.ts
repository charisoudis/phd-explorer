import { json } from '@sveltejs/kit';
import { Redis } from '@upstash/redis';
import { UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN } from '$env/static/private';

const redis = new Redis({
    url: UPSTASH_REDIS_REST_URL,
    token: UPSTASH_REDIS_REST_TOKEN
});

export async function GET() {
    const status = await redis.get('phd_jobs_status') || {
        isRunning: false,
        step1Gemini: 'pending',
        step1OpenAI: 'pending',
        step2Combine: 'pending',
        step3Parse: 'pending'
    };
    return json(status);
}