require("dotenv").config();
import * as moviedb from "./getTmdb.js";
import * as Utils from '../utils/parseProps.js';
import { getMeta } from './getMeta.js';
import { cacheWrapMetaSmart } from './getCache.js';
import { UserConfig } from '../types/index.js';
import { attachProviderPageMetadata } from './catalogSourceAdapter.js';
const consola = require('consola');

const logger = consola.withTag('GetTrending'); 

async function getTrending(type: string, language: string, page: number, genre: string, config: UserConfig, userUUID: string, includeVideos: boolean = false): Promise<{ metas: any[] }> {
  const startTime = performance.now();
  try {
    logger.debug(`[getTrending] Fetching trending for type=${type}, language=${language}, page=${page}, genre=${genre}`);
    const media_type = type === "series" ? "tv" : type;
    const time_window = genre && ['day', 'week'].includes(genre.toLowerCase()) ? genre.toLowerCase() : "day";
    
    const parameters = { media_type, time_window, language, page };
    
    const tmdbStartTime = performance.now();
    const res: any = await moviedb.trending(parameters, config);
    const tmdbTime = performance.now() - tmdbStartTime;
    logger.debug(`[getTrending] TMDB trending fetch took ${tmdbTime.toFixed(2)}ms`);
    
    const metasStartTime = performance.now();
    let preferredProvider;
    if (type === 'movie') {
      preferredProvider = config.providers?.movie || 'tmdb';
    } else {
      preferredProvider = config.providers?.series || 'tvdb';
    }

    const metas = await Promise.all((res?.results || []).map(async (item: any) => {
      let stremioId = `tmdb:${item.id}`;
      const result =  await cacheWrapMetaSmart(userUUID, stremioId, async () => {
        return await getMeta(type, language, stremioId, config, userUUID, includeVideos);
      }, undefined, {enableErrorCaching: true, maxRetries: 2, config}, type as any, includeVideos);
      
      if (result && result.meta) {
        
        const certifications: any = type === 'movie'
            ? await moviedb.getMovieCertifications({ id: item.id }, config)
            : await moviedb.getTvCertifications({ id: item.id }, config);
        result.meta.app_extras = result.meta.app_extras || {};
        const cert = type === 'movie'
            ? Utils.getTmdbMovieCertificationForCountry(certifications)
            : Utils.getTmdbTvCertificationForCountry(certifications);
        result.meta.app_extras.certification = cert;
        const trendCountry = language?.split('-')[1];
        result.meta.app_extras.certificationLocal = trendCountry && trendCountry !== 'US'
            ? (type === 'movie' ? Utils.getTmdbMovieCertificationForCountry(certifications, trendCountry) : Utils.getTmdbTvCertificationForCountry(certifications, trendCountry)) || cert
            : cert;
            
        return result.meta;
      }
      return null;
    }));
    const metasTime = performance.now() - metasStartTime;
    const validMetas = metas.filter(meta => meta !== null);
    logger.debug(`[getTrending] ${validMetas.length} Metas processing took ${metasTime.toFixed(2)}ms`);

    const totalTime = performance.now() - startTime;
    logger.debug(`[getTrending] Total function execution took ${totalTime.toFixed(2)}ms`);
    
    return {
      metas: attachProviderPageMetadata(validMetas, {
        rawCount: (res?.results || []).length,
        rawItems: res?.results || [],
        hasMore: Number(res?.page || page) < Number(res?.total_pages || 1),
        total: res?.total_results,
      }),
    };

  } catch (error: any) {
    console.error(`Error fetching trending for type=${type}:`, error.message);
    throw error;
  }
}

export { getTrending };
