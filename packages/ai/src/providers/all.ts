import { createImagesModels, type ImagesProvider, type MutableImagesModels } from "../images-models.ts";
import { type CreateModelsOptions, createModels, type MutableModels, type Provider } from "../models.ts";
import type { Api, Model } from "../types.ts";

// Daas has no bundled cloud catalog. All models come from local models.json.
export type BuiltinProvider = string;
export function getBuiltinModel(_provider: string, _modelId: string): Model<Api> | undefined {
	return undefined;
}
export function getBuiltinProviders(): BuiltinProvider[] {
	return [];
}
export function getBuiltinModelDataGeneratedAt(): number | undefined {
	return undefined;
}
export function getBuiltinModels(_provider: string): Model<Api>[] {
	return [];
}
export function builtinProviders(): Provider[] {
	return [];
}
export function builtinModels(options?: CreateModelsOptions): MutableModels {
	return createModels(options);
}
export function builtinImagesProviders(): ImagesProvider[] {
	return [];
}
export function builtinImagesModels(options?: CreateModelsOptions): MutableImagesModels {
	return createImagesModels(options);
}
