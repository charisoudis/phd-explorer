<script lang="ts">
    import { invalidateAll } from '$app/navigation';
    import type { PageProps } from './$types';
    import {
        Search, MapPin, Clock, ExternalLink, RefreshCw, LoaderCircle,
        Database, ShieldCheck, Cpu, Info
    } from 'lucide-svelte';
    import Chart from 'chart.js/auto';

    let { data }: PageProps = $props();

    // 1. UI States
    let isTriggering = $state(false); // Optimistic UI trigger
    let isClientLoaded = $state(false);
    let uniFilter = $state('All');
    let focusFilter = $state('All');

    // 2. Derived state from server data
    let status = $derived(data.status);
    let jobsData = $derived(data.jobsData?.data || []);
    let fetchDate = $derived(data.jobsData?.metadata?.fetchDate);

    // Sync: Turn off local triggering once the server confirms it's running
    $effect(() => {
        if (status.isRunning && isTriggering) {
            isTriggering = false;
        }
    });

    let universities = $derived(['All', ...new Set(jobsData.map((j) => j.university))]);
    let focusAreas = $derived(['All', ...new Set(jobsData.map((j) => j.focus))]);

    let filteredJobs = $derived(jobsData.filter((j) => {
        const matchUni = uniFilter === 'All' || j.university === uniFilter;
        const matchFocus = focusFilter === 'All' || j.focus === focusFilter;
        return matchUni && matchFocus;
    }));

    // 3. Polling Logic (Updated to 20 seconds)
    $effect(() => {
        let interval: ReturnType<typeof setInterval>;
        if (status.isRunning) {
            interval = setInterval(() => {
                invalidateAll();
            }, 20000); // 20 seconds
        }
        return () => { if (interval) clearInterval(interval); };
    });

    // 4. Chart Logic (Stabilized against flickering)
    let chartCanvas = $state<HTMLCanvasElement | null>(null);
    let chartInstance: Chart | null = null;
    let lastChartDataJson = $state(""); // Track actual data to prevent redraws

    const INDIGO_PALETTE = ['#312e81', '#3730a3', '#4f46e5', '#6366f1', '#818cf8', '#a5b4fc'];

    $effect(() => {
        isClientLoaded = true;
        const canvas = chartCanvas;
        if (!canvas || filteredJobs.length === 0) return;

        // Calculate distribution
        const focusCounts: Record<string, number> = {};
        filteredJobs.forEach((job) => {
            focusCounts[job.focus] = (focusCounts[job.focus] || 0) + 1;
        });

        // FIX: Only redraw if the data values actually changed
        const currentDataJson = JSON.stringify(focusCounts);
        if (currentDataJson === lastChartDataJson && chartInstance) return;

        lastChartDataJson = currentDataJson;

        if (chartInstance) {
            chartInstance.destroy();
        }

        chartInstance = new Chart(canvas, {
            type: 'doughnut',
            data: {
                labels: Object.keys(focusCounts),
                datasets: [{
                    data: Object.values(focusCounts),
                    backgroundColor: INDIGO_PALETTE,
                    borderWidth: 2,
                    borderColor: '#eef2ff'
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                cutout: '70%',
                animation: { duration: 400 },
                plugins: {
                    legend: {
                        position: 'right',
                        labels: { boxWidth: 10, padding: 12, font: { weight: 'bold', size: 11 } }
                    }
                }
            }
        });
    });

    // 5. Loading Text
    let currentResearchStep = $derived(() => {
        if (status.step1Gemini === 'loading' || status.step1OpenAI === 'loading') return "Deep research in progress...";
        if (status.step2Combine === 'loading') return "Cross-validating data...";
        if (status.step3Parse === 'loading') return "Structuring findings...";
        if (isTriggering || status.isRunning) return "Initializing AI Agents...";
        return "";
    });

    async function runDeepResearch() {
        if (status.isRunning) return;
        const passcode = prompt('Enter Admin Passcode:');
        if (!passcode) return;

        // Optimistic UI: Show modal immediately
        isTriggering = true;

        try {
            const response = await fetch('/api/cron', {
                headers: { 'Authorization': `Bearer ${passcode}` }
            });

            if (response.status === 401) {
                alert("Unauthorized: Invalid Passcode");
                isTriggering = false;
                return;
            }

            // Immediately invalidate to start the polling cycle
            await invalidateAll();
        } catch (e) {
            console.error(e);
            isTriggering = false;
        }
    }

    function getUniversityLogo(uni: string) {
        const u = uni.toLowerCase();
        if (u.includes('eth')) return '/logos/eth.svg';
        if (u.includes('epf')) return '/logos/epfl.svg';
        if (u.includes('uzh') || u.includes('zurich')) return '/logos/uzh.svg';
        if (u.includes('bern')) return '/logos/bern.svg';
        if (u.includes('basel')) return '/logos/basel.svg';
        if (u.includes('genev')) return '/logos/geneva.svg';
        return null;
    }
</script>

<div class="min-h-screen bg-indigo-50 text-indigo-950 font-sans p-4 md:p-8 relative">

    {#if !isClientLoaded}
        <div class="fixed inset-0 z-40 bg-indigo-50 flex flex-col items-center justify-center">
            <LoaderCircle class="w-10 h-10 text-indigo-600 animate-spin mb-4" />
            <p class="text-indigo-900 font-medium animate-pulse">Initializing Dashboard...</p>
        </div>
    {/if}

    {#if isTriggering || status.isRunning}
        <div class="fixed inset-0 z-50 flex items-center justify-center bg-indigo-950/80 backdrop-blur-sm transition-opacity duration-300">
            <div class="bg-white p-8 rounded-2xl shadow-2xl max-w-md w-full border border-indigo-100 transform transition-all scale-100">
                <div class="flex items-center gap-4 mb-6">
                    <div class="relative">
                        <LoaderCircle class="w-8 h-8 text-indigo-600 animate-spin" />
                        <div class="absolute inset-0 bg-indigo-400 blur-md opacity-30 rounded-full animate-pulse"></div>
                    </div>
                    <h3 class="text-xl font-bold text-indigo-900">Deep Research Active</h3>
                </div>

                <div class="space-y-4">
                    <div class="flex items-center gap-3 text-indigo-700 text-sm font-medium bg-indigo-50 p-3 rounded-lg">
                        <ShieldCheck class="w-4 h-4" />
                        <span>Multi-Agent Validation Enabled</span>
                    </div>
                    <div class="flex items-center gap-3 text-indigo-700 text-sm font-medium bg-indigo-50 p-3 rounded-lg">
                        <MapPin class="w-4 h-4" />
                        <span>Region: Switzerland (Top Universities)</span>
                    </div>
                    <div class="mt-6 p-4 border border-indigo-100 rounded-lg bg-indigo-950 text-indigo-100 font-mono text-xs">
                        <div class="flex items-center gap-2">
                            <span class="w-2 h-2 rounded-full bg-indigo-400 animate-pulse"></span>
                            {currentResearchStep()}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    {/if}

    <div class="max-w-6xl mx-auto space-y-8" class:opacity-0={!isClientLoaded} class:transition-opacity={true} class:duration-500={true}>

        <header class="flex flex-col md:flex-row justify-between items-start md:items-center gap-6 bg-white p-6 rounded-2xl shadow-sm border border-indigo-100">
            <div>
                <div class="flex items-center gap-3">
                    <h1 class="text-3xl font-extrabold tracking-tight text-indigo-950 flex items-center gap-3">
                        <Cpu class="w-8 h-8 text-indigo-600" />
                        Swiss CV PhD Placements
                    </h1>
                    <div class="relative group cursor-help mt-1">
                        <Info class="w-5 h-5 text-indigo-400 hover:text-indigo-600 transition-colors" />
                        <div class="absolute left-1/2 -translate-x-1/2 bottom-full mb-2 w-48 p-2 bg-indigo-900 text-xs text-indigo-50 text-center rounded opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-10">
                            Last Refreshed: <br>
                            {fetchDate ? new Date(fetchDate).toLocaleString() : 'Never'}
                            <div class="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-indigo-900"></div>
                        </div>
                    </div>
                </div>
                <p class="text-indigo-600 font-medium mt-1">100% Computer Vision & Foundation Models</p>
            </div>

            <div class="relative group">
                <button
                        onclick={runDeepResearch}
                        disabled={isTriggering || status.isRunning}
                        class="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white px-6 py-3 rounded-xl font-semibold transition-all shadow-md hover:shadow-lg disabled:opacity-50 disabled:cursor-not-allowed"
                >
                    <RefreshCw class="w-5 h-5 {isTriggering || status.isRunning ? 'animate-spin' : ''}" />
                    {isTriggering || status.isRunning ? 'Running...' : 'Run Deep Research'}
                </button>
            </div>
        </header>

        <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div class="lg:col-span-1 flex flex-col gap-6">
                <div class="bg-indigo-600 rounded-2xl p-6 shadow-sm border border-indigo-700 text-white flex flex-col justify-center items-center text-center h-full min-h-50">
                    <Database class="w-8 h-8 text-indigo-300 mb-2" />
                    <div class="text-5xl font-black mb-1">{filteredJobs.length}</div>
                    <div class="text-indigo-200 text-sm font-semibold uppercase tracking-widest">Active Placements</div>
                </div>

                <div class="bg-white rounded-2xl p-5 shadow-sm border border-indigo-100 space-y-4">
                    <div>
                        <label for="uni-filter" class="block text-xs font-bold text-indigo-400 uppercase tracking-wider mb-2">Institution</label>
                        <select id="uni-filter" bind:value={uniFilter} class="w-full bg-indigo-50 border-none text-indigo-900 rounded-lg focus:ring-2 focus:ring-indigo-500 p-2.5 outline-none font-medium">
                            {#each universities as u} <option value={u}>{u}</option> {/each}
                        </select>
                    </div>
                    <div>
                        <label for="focus-filter" class="block text-xs font-bold text-indigo-400 uppercase tracking-wider mb-2">Research Focus</label>
                        <select id="focus-filter" bind:value={focusFilter} class="w-full bg-indigo-50 border-none text-indigo-900 rounded-lg focus:ring-2 focus:ring-indigo-500 p-2.5 outline-none font-medium">
                            {#each focusAreas as f} <option value={f}>{f}</option> {/each}
                        </select>
                    </div>
                </div>
            </div>

            <div class="lg:col-span-2 bg-white rounded-2xl p-6 shadow-sm border border-indigo-100 flex flex-col">
                <h2 class="text-lg font-bold text-indigo-900 mb-4">Focus Distribution</h2>
                <div class="grow relative w-full flex items-center justify-center min-h-62.5">
                    {#if filteredJobs.length > 0}
                        <div class="relative w-full max-w-lg h-62.5 md:h-75">
                            <canvas bind:this={chartCanvas}></canvas>
                        </div>
                    {:else}
                        <div class="text-indigo-300 font-medium">No data to chart</div>
                    {/if}
                </div>
            </div>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {#each filteredJobs as job (job.id)}
                <div class="bg-white rounded-2xl p-6 border border-indigo-100 hover:border-indigo-300 shadow-sm hover:shadow-lg transition-all flex flex-col group relative overflow-hidden">
                    <div class="flex justify-between items-start mb-4">
                        {#if getUniversityLogo(job.university)}
                            <img src={getUniversityLogo(job.university)} alt={job.university} class="h-6 object-contain opacity-80" />
                        {:else}
                            <span class="bg-indigo-100 text-indigo-800 text-xs font-bold px-2.5 py-1 rounded-md uppercase tracking-wide">
                                {job.university}
                            </span>
                        {/if}

                        <span class="flex items-center gap-1 text-indigo-400 text-xs font-semibold whitespace-nowrap bg-indigo-50 px-2 py-1 rounded">
                            <Clock class="w-3 h-3" /> {job.deadline}
                        </span>
                    </div>

                    <h3 class="text-lg font-bold text-indigo-950 leading-tight mb-2 group-hover:text-indigo-600 transition-colors">{job.title}</h3>
                    <div class="flex items-center gap-1 text-indigo-500 text-sm font-medium mb-4">
                        <MapPin class="w-4 h-4" /> {job.location}
                    </div>

                    <p class="text-indigo-700/80 text-sm mb-6 grow leading-relaxed">
                        {job.desc}
                    </p>

                    <div class="mt-auto pt-4 border-t border-indigo-50 flex items-center justify-between">
                        <span class="text-xs font-bold text-indigo-500 uppercase tracking-wider bg-indigo-50 px-3 py-1.5 rounded-lg">{job.focus}</span>
                        <a
                                href={job.link}
                                onclick={(e) => { if (!job.link.startsWith('http')) e.preventDefault(); }}
                                target="_blank"
                                rel="noopener noreferrer"
                                class="p-2.5 rounded-lg bg-indigo-50 hover:bg-indigo-600 text-indigo-600 hover:text-white transition-colors flex items-center justify-center shadow-sm"
                                title="View Position"
                        >
                            <ExternalLink class="w-4 h-4" />
                        </a>
                    </div>
                </div>
            {/each}

            {#if filteredJobs.length === 0}
                <div class="col-span-full py-16 text-center text-indigo-400 bg-white rounded-2xl border border-indigo-100 border-dashed">
                    <Search class="w-12 h-12 mx-auto mb-4 opacity-50" />
                    <p class="font-medium text-lg text-indigo-900">No positions match your criteria.</p>
                    <p class="text-sm mt-1">Try adjusting your filters or running a new Deep Research scan.</p>
                </div>
            {/if}
        </div>
    </div>
</div>