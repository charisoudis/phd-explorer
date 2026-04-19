import { Redis } from '@upstash/redis';
import { UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN } from '$env/static/private';

const redis = new Redis({
    url: UPSTASH_REDIS_REST_URL,
    token: UPSTASH_REDIS_REST_TOKEN
});

export async function load() {
    const status = await redis.get('phd_jobs_status');
    const jobsData = await redis.get('phd_jobs_data');

    return {
        status: status || { isRunning: false },
        jobsData: jobsData || { metadata: null, data: [] }
    };
}