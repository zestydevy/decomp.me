import { useState, useCallback, useEffect } from "react"

import { useRouter } from "next/router"

import useSWR, { Revalidator, RevalidatorOptions, mutate } from "swr"
import { useDebouncedCallback } from "use-debounce"

import { ignoreNextWarnBeforeUnload } from "./hooks"

const API_BASE = process.env.INTERNAL_API_BASE ?? process.env.NEXT_PUBLIC_API_BASE ?? process.env.STORYBOOK_API_BASE

type Json = any

const commonOpts: RequestInit = {
    credentials: "include",
    cache: "reload",
    headers: {
        "Accept": "application/json",
    },
}

/*
function isAbsoluteUrl(maybeUrl: string): boolean {
    return maybeUrl.startsWith("https://") || maybeUrl.startsWith("http://")
}
*/

function onErrorRetry<C>(error: ResponseError, key: string, config: C, revalidate: Revalidator, { retryCount }: RevalidatorOptions) {
    if (error.status === 404) return
    if (retryCount >= 10) return

    // Retry after 5 seconds
    setTimeout(() => revalidate({ retryCount }), 5000)
}

function undefinedIfUnchanged<O, K extends keyof O>(saved: O, local: O, key: K): O[K] | undefined {
    if (saved[key] !== local[key]) {
        return local[key]
    }
}

export class ResponseError extends Error {
    status: number
    responseJSON: Json
    code: string

    constructor(response: Response, responseJSON) {
        super(`Server responded with HTTP status code ${response.status}`)

        this.status = response.status
        this.responseJSON = responseJSON
        this.code = responseJSON.code
        this.message = responseJSON?.detail
        this.name = "ResponseError"
    }
}

export async function get(url: string, useCacheIfFresh = false) {
    if (url.startsWith("/")) {
        url = API_BASE + url
    }

    const response = await fetch(url, {
        ...commonOpts,
        cache: useCacheIfFresh ? "default" : "no-cache",
    })

    if (!response.ok) {
        throw new ResponseError(response, await response.json())
    }

    try {
        return await response.json()
    } catch (error) {
        if (error instanceof SyntaxError) {
            throw new ResponseError(response, {
                code: "invalid_json",
                detail: "The server returned invalid JSON",
            })
        }

        throw error
    }
}

export const getCached = (url: string) => get(url, true)

export async function post(url: string, json: Json) {
    if (url.startsWith("/")) {
        url = API_BASE + url
    }

    const body: string = JSON.stringify(json)

    console.info("POST", url, JSON.parse(body))

    const response = await fetch(url, {
        ...commonOpts,
        method: "POST",
        body,
        headers: {
            "Content-Type": "application/json",
        },
    })

    if (!response.ok) {
        throw new ResponseError(response, await response.json())
    }

    return await response.json()
}

export async function patch(url: string, json: Json) {
    if (url.startsWith("/")) {
        url = API_BASE + url
    }

    const body = JSON.stringify(json)

    console.info("PATCH", url, JSON.parse(body))

    const response = await fetch(url, {
        ...commonOpts,
        method: "PATCH",
        body,
        headers: {
            "Content-Type": "application/json",
        },
    })

    if (!response.ok) {
        throw new ResponseError(response, await response.json())
    }

    const text = await response.text()
    if (!text) {
        return
    }
    return JSON.parse(text)
}

export interface Page<T> {
    next: string | null
    previous: string | null
    results: T[]
}

export interface AnonymousUser {
    is_anonymous: true
    id: number
}

export interface User {
    is_anonymous: false
    id: number
    username: string
    name: string
    avatar_url: string | null
    github_api_url: string | null
    github_html_url: string | null
}

export interface TerseScratch {
    url: string
    html_url: string
    owner: AnonymousUser | User | null // null means unclaimed
    name: string
    creation_time: string
    last_updated: string
    compiler: string
    platform: string
    score: number
    max_score: number
}

export interface Scratch extends TerseScratch {
    slug: string // avoid using, use `url` instead
    description: string
    compiler_flags: string
    source_code: string
    context: string
    diff_label: string
    parent: string | null
}

export type Compilation = {
    errors: string
    diff_output: DiffOutput | null
}

export type DiffOutput = {
    arch_str: string
    current_score: number
    max_score: number
    error: string | null
    header: DiffHeader
    rows: DiffRow[]
}

export type DiffHeader = {
    base: DiffText[]
    current: DiffText[]
    previous?: DiffText[]
}

export type DiffRow = {
    key: string
    base?: DiffCell
    current?: DiffCell
    previous?: DiffCell
}

export type DiffCell = {
    text: DiffText[]
    line?: number
    branch?: number
    src?: string
    src_comment?: string
    src_line?: number
    src_path?: string
}

export type DiffText = {
    text: string
    format?: string
    group?: string
    index?: number
    key?: string
}

export function isAnonUser(user: User | AnonymousUser): user is AnonymousUser {
    return user.is_anonymous
}

export function useThisUser(): User | AnonymousUser | undefined {
    const { data: user, error } = useSWR<AnonymousUser | User>("/user", get)

    if (error) {
        throw error
    }

    return user
}

export function isUserEq(a: User | AnonymousUser | undefined, b: User | AnonymousUser | undefined): boolean {
    return a && b && a.id === b.id && a.is_anonymous === b.is_anonymous
}

export function useUserIsYou(): (user: User | AnonymousUser | undefined) => boolean {
    const you = useThisUser()

    return useCallback(user => {
        return isUserEq(you, user)
    }, [you && you.id, you && you.is_anonymous]) // eslint-disable-line react-hooks/exhaustive-deps
}

export function useSavedScratch(scratch: Scratch): Scratch {
    const { data: savedScratch, error } = useSWR(scratch.url, get, {
        fallbackData: scratch, // No loading state, just use the local scratch
    })

    if (error)
        throw error

    return savedScratch
}

export function useSaveScratch(localScratch: Scratch): () => Promise<Scratch> {
    const savedScratch = useSavedScratch(localScratch)
    const userIsYou = useUserIsYou()

    const saveScratch = useCallback(async () => {
        if (!localScratch) {
            throw new Error("Cannot save scratch before it is loaded")
        }
        if (!userIsYou(localScratch.owner)) {
            throw new Error("Cannot save scratch which you do not own")
        }

        const updatedScratch = await patch(localScratch.url, {
            source_code: undefinedIfUnchanged(savedScratch, localScratch, "source_code"),
            context: undefinedIfUnchanged(savedScratch, localScratch, "context"),
            compiler: undefinedIfUnchanged(savedScratch, localScratch, "compiler"),
            compiler_flags: undefinedIfUnchanged(savedScratch, localScratch, "compiler_flags"),
            name: undefinedIfUnchanged(savedScratch, localScratch, "name"),
            description: undefinedIfUnchanged(savedScratch, localScratch, "description"),
        })

        await mutate(localScratch.url, updatedScratch, false)

        return updatedScratch
    }, [localScratch, savedScratch, userIsYou])

    return saveScratch
}

export async function claimScratch(scratch: Scratch): Promise<void> {
    const { success } = await post(`${scratch.url}/claim`, {})
    const user = await get("/user")

    if (!success)
        throw new Error("Scratch already claimed")

    await mutate(scratch.url, {
        ...scratch,
        owner: user,
    })
}

export async function forkScratch(parent: Scratch): Promise<Scratch> {
    const scratch = await post(`${parent.url}/fork`, parent)
    await claimScratch(scratch)
    return scratch
}

export function useForkScratchAndGo(parent: Scratch): () => Promise<void> {
    const router = useRouter()

    return useCallback(async () => {
        const fork = await forkScratch(parent)

        ignoreNextWarnBeforeUnload()
        await router.push(fork.html_url)
    }, [router, parent])
}

export function useIsScratchSaved(scratch: Scratch): boolean {
    const saved = useSavedScratch(scratch)

    return (
        scratch.name === saved.name &&
        scratch.description === saved.description &&
        scratch.compiler === saved.compiler &&
        scratch.compiler_flags === saved.compiler_flags &&
        scratch.source_code === saved.source_code &&
        scratch.context === saved.context
    )
}

export function useCompilation(scratch: Scratch | null, autoRecompile = true, initial = null): {
    compilation: Readonly<Compilation> | null
    compile: () => Promise<void> // no debounce
    debouncedCompile: () => Promise<void> // with debounce
    isCompiling: boolean
} {
    const savedScratch = useSavedScratch(scratch)
    const [compileRequestPromise, setCompileRequestPromise] = useState<Promise<void>>(null)
    const [compilation, setCompilation] = useState<Compilation>(initial)

    const compile = useCallback(() => {
        if (compileRequestPromise)
            return compileRequestPromise

        if (!scratch)
            return Promise.reject(new Error("Cannot compile without a scratch"))

        if (!scratch.compiler)
            return Promise.reject(new Error("Cannot compile before a compiler is set"))

        const promise = post(`${scratch.url}/compile`, {
            // TODO: api should take { scratch } and support undefinedIfUnchanged on all fields
            compiler: scratch.compiler,
            compiler_flags: scratch.compiler_flags,
            source_code: scratch.source_code,
            context: savedScratch ? undefinedIfUnchanged(savedScratch, scratch, "context") : scratch.context,
        }).then((compilation: Compilation) => {
            setCompilation(compilation)
        }).finally(() => {
            setCompileRequestPromise(null)
        }).catch(error => {
            setCompilation({ "errors": error.responseJSON?.detail, "diff_output": null })
        })

        setCompileRequestPromise(promise)

        return promise
    }, [compileRequestPromise, savedScratch, scratch])

    // If the scratch we're looking at changes, we need to recompile
    const [url, setUrl] = useState(scratch.url)
    useEffect(() => {
        if (url !== scratch.url) {
            setUrl(scratch.url)
            compile()
        }
    }, [compile, scratch.url, url])

    const debouncedCompile = useDebouncedCallback(compile, 500, { leading: false, trailing: true })

    useEffect(() => {
        if (!compilation) {
            compile()
        } else if (autoRecompile) {
            if (scratch && scratch.compiler !== "")
                debouncedCompile()
            else
                setCompilation(null)
        }
    }, [ // eslint-disable-line react-hooks/exhaustive-deps
        debouncedCompile,
        autoRecompile,

        // fields passed to compilations
        scratch.compiler, scratch.compiler_flags,
        scratch.source_code, scratch.context,
    ])

    return {
        compilation,
        compile,
        debouncedCompile,
        isCompiling: !!compileRequestPromise || debouncedCompile.isPending(),
    }
}

export function usePlatforms(): Record<string, string> {
    const { data } = useSWR<{ "platforms": Record<string, string> }>("/compilers", getCached, {
        refreshInterval: 0,
        revalidateOnFocus: false,
        suspense: true, // TODO: remove
        onErrorRetry,
    })

    return data?.platforms
}

export function useCompilers(): Record<string, { platform: string | null }> {
    const { data } = useSWR("/compilers", get, {
        refreshInterval: 0,
        suspense: true, // TODO: remove
        onErrorRetry,
    })

    return data.compilers
}

export function usePaginated<T>(url: string): {
    results: T[]
    hasNext: boolean
    hasPrevious: boolean
    isLoading: boolean
    loadNext: () => Promise<void>
    loadPrevious: () => Promise<void>
} {
    const [results, setResults] = useState<T[]>([])
    const [next, setNext] = useState<string | null>(url)
    const [previous, setPrevious] = useState<string | null>(null)
    const [isLoading, setIsLoading] = useState(false)

    useEffect(() => {
        setResults([])
        setNext(url)
        setPrevious(null)
        setIsLoading(true)

        get(url).then((data: Page<T>) => {
            setResults(data.results)
            setNext(data.next)
            setPrevious(data.previous)
            setIsLoading(false)
        })
    }, [url])

    const loadNext = useCallback(async () => {
        if (!next)
            throw new Error("No more")

        setIsLoading(true)

        const data: Page<T> = await get(next)
        setResults(results => [...results, ...data.results])
        setNext(data.next)
        setIsLoading(false)
    }, [next])

    const loadPrevious = useCallback(async () => {
        if (!previous)
            throw new Error("No more")

        setIsLoading(true)

        const data: Page<T> = await get(previous)
        setResults(results => [...data.results, ...results])
        setPrevious(data.previous)
        setIsLoading(false)
    }, [previous])

    return {
        results,
        hasNext: !!next,
        hasPrevious: !!previous,
        isLoading,
        loadNext,
        loadPrevious,
    }
}
