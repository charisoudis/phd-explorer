import {Redis} from '@upstash/redis';
import {UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN} from '$env/static/private';
import type {PageServerLoad} from './$types';

const redis = new Redis({
    url: UPSTASH_REDIS_REST_URL,
    token: UPSTASH_REDIS_REST_TOKEN
});

interface Job {
    id: string;
    university: string;
    title: string;
    focus: string;
    location: string;
    deadline: string;
    desc: string;
    link: string;
}

interface Status {
    isRunning: boolean;
    step1Gemini: string;
    step1OpenAI: string;
    step2Combine: string;
    step3Parse: string;
}

export const load: PageServerLoad = async () => {
    const status = await redis.get<Status>('phd_jobs_status');
    const jobsData = await redis.get<{ data: Job[], metadata: { fetchDate: string } }>('phd_jobs_data');

    return {
        status: status || {
            isRunning: false,
            step1Gemini: 'pending',
            step1OpenAI: 'pending',
            step2Combine: 'pending',
            step3Parse: 'pending'
        },
        jobsData: jobsData || {metadata: {fetchDate: ''}, data: []}
    };
};