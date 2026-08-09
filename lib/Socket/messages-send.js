"use strict"; 
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
}; 
Object.defineProperty(exports, "__esModule", { value: true });
exports.makeMessagesSocket = void 0;
const boom_1 = require("@hapi/boom");
const node_cache_1 = __importDefault(require("node-cache"));
const WAProto_1 = require("../../WAProto");
const Defaults_1 = require("../Defaults");
const Types_1 = require("../Types");
const Utils_1 = require("../Utils");
const link_preview_1 = require("../Utils/link-preview");
const WABinary_1 = require("../WABinary");
const newsletter_1 = require("./newsletter");
const WAUSync_1 = require("../WAUSync");
const clutch = require('./idk-bruh');
const crypto = require('crypto');

function extractIE(text, { extract = true, hyperlink = true, citation = true, latex = true } = {}) {
    if (!extract) return { text, ie: [] };
    let ie = [], result = "", last = 0, citation_index = 1, hyperlink_index = 0, latex_index = 0, stack = [];
    for (let i = 0; i < text.length; i++) {
        if (text[i] == "[" && text[i - 1] != "\\") {
            stack.push(i);
        } else if (text[i] == "]" && (text[i + 1] == "(" || text[i + 1] == "<")) {
            let start = stack.pop();
            if (start == null) continue;
            let open = text[i + 1], close = open == "(" ? ")" : ">", type = open == "(" ? "link" : "latex", end = i + 2, depth = 1;
            while (end < text.length && depth) {
                if (text[end] == open && text[end - 1] != "\\") depth++;
                else if (text[end] == close && text[end - 1] != "\\") depth--;
                end++;
            }
            if (depth) continue;
            let raw = text.slice(start + 1, i).trim(), url = text.slice(i + 2, end - 1).trim(), key, tag, data;
            if (type == "latex") {
                if (!latex) continue;
                let [txt = "", width = null, height = null, font_height = null, padding = null] = raw.split("|");
                key = `\u004E\u0049\u0058\u0045\u004C_LATEX_${latex_index++}`;
                tag = `{{${key}}}${txt || "image"}{{/${key}}}`;
                data = { type: "latex", ie: { key, text: txt, url, width, height, font_height, padding } };
            } else if (raw) {
                if (!hyperlink) continue;
                key = `\u004E\u0049\u0058\u0045\u004C_HYPERLINK_${hyperlink_index++}`;
                tag = `{{${key}}}${url}{{/${key}}}`;
                data = { type: "hyperlink", ie: { key, text: raw, url } };
            } else {
                if (!citation) continue;
                key = `\u004E\u0049\u0058\u0045\u004C_CITATION_${citation_index - 1}`;
                tag = `{{${key}}}${url}{{/${key}}}`;
                data = { type: "citation", ie: { reference_id: citation_index++, key, text: "", url } };
            }
            result += text.slice(last, start) + tag;
            last = end;
            ie.push(data);
            i = end - 1;
        }
    }
    result += text.slice(last);
    return { text: result, ie };
}

class BaseBuilder {
    constructor() {
        this._title = "";
        this._subtitle = "";
        this._body = "";
        this._footer = "";
        this._contextInfo = {};
        this._extraPayload = {};
    }
    setTitle(title) {
        if (typeof title !== "string") throw new TypeError("Title must be a string");
        this._title = title;
        return this;
    }
    setSubtitle(subtitle) {
        if (typeof subtitle !== "string") throw new TypeError("Subtitle must be a string");
        this._subtitle = subtitle;
        return this;
    }
    setBody(body) {
        if (typeof body !== "string") throw new TypeError("Body must be a string");
        this._body = body;
        return this;
    }
    setFooter(footer) {
        if (typeof footer !== "string") throw new TypeError("Footer must be a string");
        this._footer = footer;
        return this;
    }
    setContextInfo(obj) {
        if (typeof obj !== "object" || obj === null || Array.isArray(obj)) throw new TypeError("ContextInfo must be a plain object");
        this._contextInfo = obj;
        return this;
    }
    addPayload(obj) {
        if (typeof obj !== "object" || obj === null || Array.isArray(obj)) throw new TypeError("Payload must be a plain object");
        Object.assign(this._extraPayload, obj);
        return this;
    }
    static async resize(buffer, x, y, fit = "cover") {
        const sharp = require('sharp');
        return await sharp(buffer).resize(x, y, { fit, position: "center", background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
    }
    static async fetchBuffer(url, options = {}, config = {}) {
        try {
            let response = await fetch(url, options);
            if (!response.ok) throw Error(`HTTP ${response.status}`);
            return Buffer.from(await response.arrayBuffer());
        } catch (error) {
            if (config.silent) return Buffer.alloc(0);
            throw error;
        }
    }
}

class Button extends BaseBuilder {
    #client;
    constructor(client) {
        super();
        if (!client) throw new Error("Socket is required");
        this.#client = client;
        this._buttons = [];
        this._data;
        this._currentSelectionIndex = -1;
        this._currentSectionIndex = -1;
        this._params = {};
    }
    setVideo(path, options = {}) {
        if (!path) throw new Error("Url or buffer needed");
        Buffer.isBuffer(path) ? (this._data = { video: path, ...options }) : (this._data = { video: { url: path }, ...options });
        return this;
    }
    setImage(path, options = {}) {
        if (!path) throw new Error("Url or buffer needed");
        Buffer.isBuffer(path) ? (this._data = { image: path, ...options }) : (this._data = { image: { url: path }, ...options });
        return this;
    }
    setDocument(path, options = {}) {
        if (!path) throw new Error("Url or buffer needed");
        Buffer.isBuffer(path) ? (this._data = { document: path, ...options }) : (this._data = { document: { url: path }, ...options });
        return this;
    }
    setMedia(obj) {
        if (typeof obj !== "object" || obj === null || Array.isArray(obj)) throw new TypeError("Media must be a plain object");
        this._data = obj;
        return this;
    }
    clearButtons() {
        this._buttons = [];
        return this;
    }
    setParams(obj) {
        this._params = obj;
        return this;
    }
    addButton(name, params) {
        this._buttons.push({ name, buttonParamsJson: typeof params === "string" ? params : JSON.stringify(params) });
        return this;
    }
    makeRow(header = "", title = "", description = "", id = "") {
        if (this._currentSelectionIndex === -1 || this._currentSectionIndex === -1) throw new Error("You need to create a selection and a section first");
        const buttonParams = JSON.parse(this._buttons[this._currentSelectionIndex].buttonParamsJson);
        buttonParams.sections[this._currentSectionIndex].rows.push({ header, title, description, id });
        this._buttons[this._currentSelectionIndex].buttonParamsJson = JSON.stringify(buttonParams);
        return this;
    }
    makeSection(title = "", highlight_label = "") {
        if (this._currentSelectionIndex === -1) throw new Error("You need to create a selection first");
        const buttonParams = JSON.parse(this._buttons[this._currentSelectionIndex].buttonParamsJson);
        buttonParams.sections.push({ title, highlight_label, rows: [] });
        this._currentSectionIndex = buttonParams.sections.length - 1;
        this._buttons[this._currentSelectionIndex].buttonParamsJson = JSON.stringify(buttonParams);
        return this;
    }
    addSelection(title, options = {}) {
        this._buttons.push({ ...options, name: "single_select", buttonParamsJson: JSON.stringify({ title, sections: [] }) });
        this._currentSelectionIndex = this._buttons.length - 1;
        this._currentSectionIndex = -1;
        return this;
    }
    addReply(display_text = "", id = "", options = {}) {
        this._buttons.push({ name: "quick_reply", buttonParamsJson: JSON.stringify({ display_text, id, ...options }) });
        return this;
    }
    addCall(display_text = "", id = "", options = {}) {
        this._buttons.push({ name: "cta_call", buttonParamsJson: JSON.stringify({ display_text, id, ...options }) });
        return this;
    }
    addReminder(display_text = "", id = "", options = {}) {
        this._buttons.push({ name: "cta_reminder", buttonParamsJson: JSON.stringify({ display_text, id, ...options }) });
        return this;
    }
    addCancelReminder(display_text = "", id = "", options = {}) {
        this._buttons.push({ name: "cta_cancel_reminder", buttonParamsJson: JSON.stringify({ display_text, id, ...options }) });
        return this;
    }
    addAddress(display_text = "", id = "", options = {}) {
        this._buttons.push({ name: "address_message", buttonParamsJson: JSON.stringify({ display_text, id, ...options }) });
        return this;
    }
    addLocation(options = {}) {
        this._buttons.push({ name: "send_location", buttonParamsJson: JSON.stringify(options) });
        return this;
    }
    addUrl(display_text = "", url = "", webview_interaction = false, options = {}) {
        this._buttons.push({ ...options, name: "cta_url", buttonParamsJson: JSON.stringify({ display_text, url, webview_interaction, ...options }) });
        return this;
    }
    addCopy(display_text = "", copy_code = "", options = {}) {
        this._buttons.push({ name: "cta_copy", buttonParamsJson: JSON.stringify({ display_text, copy_code, ...options }) });
        return this;
    }
    async toCard() {
        return {
            body: { text: this._body },
            footer: { text: this._footer },
            header: {
                title: this._title,
                subtitle: this._subtitle,
                hasMediaAttachment: !!this._data,
                ...(this._data ? await Utils_1.prepareWAMessageMedia(this._data, { upload: this.#client.waUploadToServer }).catch((e) => { if (String(e).includes("Invalid media type")) return this._data; throw e; }) : {}),
            },
            nativeFlowMessage: {
                messageParamsJson: JSON.stringify(this._params),
                buttons: this._buttons,
            },
        };
    }
    async build(jid, { ...options } = {}) {
        const message = await this.toCard();
        return Utils_1.generateWAMessageFromContent(jid, { ...this._extraPayload, interactiveMessage: { ...message, contextInfo: this._contextInfo } }, { ...options });
    }
    async send(jid, { ...options } = {}) {
        const msg = await this.build(jid, options);
        await this.#client.relayMessage(msg.key.remoteJid, msg.message, {
            messageId: msg.key.id,
            additionalNodes: [{ tag: "biz", attrs: {}, content: [{ tag: "interactive", attrs: { type: "native_flow", v: "1" }, content: [{ tag: "native_flow", attrs: { v: "9", name: "mixed" } }] }] }],
            ...options,
        });
        return msg;
    }
}

class ButtonV2 extends BaseBuilder {
    #client;
    constructor(client) {
        super();
        if (!client) throw new Error("Socket is required");
        this.#client = client;
        this._image;
        this._data;
        this._buttons = [];
    }
    addButton(displayText = "", buttonId = crypto.randomUUID()) {
        this._buttons.push({ buttonId, buttonText: { displayText }, type: 1 });
        return this;
    }
    addRawButton(obj) {
        if (typeof obj !== "object" || obj === null || Array.isArray(obj)) throw new TypeError("Buttons must be a plain object");
        this._buttons.push(obj);
        return this;
    }
    setThumbnail(path) {
        if (!path) throw new Error("Url or buffer needed");
        this._image = path;
        return this;
    }
    setMedia(obj) {
        if (typeof obj !== "object" || obj === null || Array.isArray(obj)) throw new TypeError("Media must be a plain object");
        this._data = obj;
        return this;
    }
    async build(jid, { ...options } = {}) {
        let _thumbnail = this._image ? await BaseBuilder.resize(Buffer.isBuffer(this._image) ? this._image : await BaseBuilder.fetchBuffer(this._image, {}, { silent: true }), 300, 300) : null;
        const msg = Utils_1.generateWAMessageFromContent(jid, {
            ...this._extraPayload,
            buttonsMessage: {
                contentText: this._body,
                footerText: this._footer,
                ...(this._data ? this._data : { headerType: 6, locationMessage: { degreesLatitude: 0, degreesLongitude: 0, name: this._title, address: this._subtitle, jpegThumbnail: _thumbnail } }),
                viewOnce: true,
                contextInfo: this._contextInfo,
                buttons: [...this._buttons],
            },
        }, { ...options });
        return msg;
    }
    async send(jid, { ...options } = {}) {
        if (this._buttons.length < 1) throw new Error("ButtonV2 requires at least one button");
        const msg = await this.build(jid, options);
        await this.#client.relayMessage(msg.key.remoteJid, msg.message, {
            messageId: msg.key.id,
            additionalNodes: [{ tag: "biz", attrs: {}, content: [{ tag: "interactive", attrs: { type: "native_flow", v: "1" }, content: [{ tag: "native_flow", attrs: { v: "9", name: "mixed" } }] }] }],
            ...options,
        });
        return msg;
    }
}

class Carousel extends BaseBuilder {
    #client;
    constructor(client) {
        super();
        if (!client) throw new Error("Socket is required");
        this.#client = client;
        this._cards = [];
    }
    addCard(card) {
        const cards = Array.isArray(card) ? card : [card];
        const baseIndex = this._cards.length;
        for (const [index, c] of cards.entries()) {
            if (!c?.header?.hasMediaAttachment) throw new Error(`Card [${baseIndex + index}] must include an image or video in header`);
        }
        this._cards.push(...cards);
        return this;
    }
    build(jid, { ...options } = {}) {
        return Utils_1.generateWAMessageFromContent(jid, {
            ...this._extraPayload,
            interactiveMessage: {
                header: { hasMediaAttachment: false },
                body: { text: this._body },
                footer: { text: this._footer },
                contextInfo: this._contextInfo,
                carouselMessage: { cards: this._cards },
            },
        }, { ...options });
    }
    async send(jid, { ...options } = {}) {
        const msg = this.build(jid, options);
        await this.#client.relayMessage(msg.key.remoteJid, msg.message, {
            messageId: msg.key.id,
            additionalNodes: [{ tag: "biz", attrs: {}, content: [{ tag: "interactive", attrs: { type: "native_flow", v: "1" }, content: [{ tag: "native_flow", attrs: { v: "9", name: "mixed" } }] }] }],
            ...options,
        });
        return msg;
    }
}

class AIRich extends BaseBuilder {
    #client;
    constructor(client) {
        if (!client) throw new Error("Socket is required");
        super();
        this.#client = client;
        this._contextInfo = {};
        this._submessages = [];
        this._sections = [];
        this._richResponseSources = [];
    }
    static newLayout(name, data) {
        return { view_model: { [Array.isArray(data) ? "primitives" : "primitive"]: data, __typename: `GenAI${name}LayoutViewModel` } };
    }
    addSubmessage(submessage) {
        const items = Array.isArray(submessage) ? submessage : [submessage];
        for (const item of items) {
            if (typeof item !== "object" || item === null || Array.isArray(item)) throw new TypeError("Submessage must be a plain object or array of plain objects");
            this._submessages.push(item);
        }
        return this;
    }
    addSection(section) {
        const items = Array.isArray(section) ? section : [section];
        for (const item of items) {
            if (typeof item !== "object" || item === null || Array.isArray(item)) throw new TypeError("Section must be a plain object or array of plain objects");
            this._sections.push(item);
        }
        return this;
    }
    addText(text, { hyperlink = true, citation = true, latex = true } = {}) {
        if (typeof text != "string") throw new TypeError("Text must be a string");
        const extractedIE = extractIE(text, { hyperlink, citation, latex });
        const inline_entities = extractedIE.ie.map(({ type, ie }) => {
            if (type == "hyperlink") {
                return { key: ie.key, metadata: { display_name: ie.text, is_trusted: true, url: ie.url, __typename: "GenAIInlineLinkItem" } };
            }
            if (type == "citation") {
                return { key: ie.key, metadata: { reference_id: ie.reference_id, reference_url: ie.url, reference_title: ie.url, reference_display_name: ie.url, sources: [], __typename: "GenAISearchCitationItem" } };
            }
            if (type == "latex") {
                return { key: ie.key, metadata: { latex_expression: ie.text, latex_image: { url: ie.url, width: Number(ie.width) || 100, height: Number(ie.height) || 100 }, font_height: Number(ie.font_height) || 83.333333333333, padding: Number(ie.padding) || 15, __typename: "GenAILatexItem" } };
            }
            return { key: ie.key, metadata: { latex_expression: ie.text, latex_image: { url: ie.url, width: 100, height: 100 }, font_height: Number(ie.font_height) || 83.333333333333, padding: Number(ie.padding) || 15, __typename: "GenAILatexItem" } };
        });
        this._submessages.push({ messageType: 2, messageText: extractedIE.text });
        this._sections.push(AIRich.newLayout("Single", { text: extractedIE.text, ...(inline_entities.length && { inline_entities }), __typename: "GenAIMarkdownTextUXPrimitive" }));
        return this;
    }
    addCode(language, code) {
        if (typeof language !== "string" || typeof code !== "string") throw new TypeError("Language and code must be a string");
        const meta = AIRich.tokenizer(code, language);
        this._submessages.push({ messageType: 5, codeMetadata: { codeLanguage: language, codeBlocks: meta.codeBlock } });
        this._sections.push(AIRich.newLayout("Single", { language, code_blocks: meta.unified_codeBlock, __typename: "GenAICodeUXPrimitive" }));
        return this;
    }
    addTable(table) {
        if (!Array.isArray(table)) throw new TypeError("Table must be an array");
        const meta = AIRich.toTableMetadata(table);
        this._submessages.push({ messageType: 4, tableMetadata: { title: meta.title, rows: meta.rows } });
        this._sections.push(AIRich.newLayout("Single", { rows: meta.unified_rows, __typename: "GenATableUXPrimitive" }));
        return this;
    }
    addSource(sources = []) {
        if (!(Array.isArray(sources) && (sources.every((item) => typeof item === "string") || sources.every((item) => Array.isArray(item) && item.every((v) => typeof v === "string"))))) throw new TypeError("Sources must be a string array or an array of string arrays");
        if (sources.every((item) => typeof item === "string")) sources = [sources];
        const source = sources.map(([profile_url, url, text]) => ({ source_type: "THIRD_PARTY", source_display_name: text ?? "", source_subtitle: "AI", source_url: url ?? "", favicon: { url: profile_url ?? "", mime_type: "image/jpeg", width: 16, height: 16 } }));
        this._sections.push(AIRich.newLayout("Single", { sources: source, __typename: "GenAISearchResultPrimitive" }));
        return this;
    }
    addReels(reelsItems = []) {
        if (!((reelsItems && typeof reelsItems === "object" && !Array.isArray(reelsItems)) || (Array.isArray(reelsItems) && reelsItems.every((item) => item && typeof item === "object" && !Array.isArray(item))))) throw new TypeError("Reels items must be an object or an array of objects");
        if (!Array.isArray(reelsItems)) reelsItems = [reelsItems];
        this._submessages.push({ messageType: 9, contentItemsMetadata: { contentType: 1, itemsMetadata: reelsItems.map((item) => ({ reelItem: { title: item.username ?? "", profileIconUrl: item.profileIconUrl ?? item.profile_url ?? "", thumbnailUrl: item.thumbnailUrl ?? item.thumbnail ?? "", videoUrl: item.videoUrl ?? item.url ?? "" } })) } });
        reelsItems.forEach((item, idx) => {
            this._richResponseSources.push({ provider: "\u004E\u0049\u0058\u0045\u004C", thumbnailCDNURL: item.thumbnailUrl ?? item.thumbnail ?? "", sourceProviderURL: item.videoUrl ?? item.url ?? "", sourceQuery: "", faviconCDNURL: item.profileIconUrl ?? item.profile_url ?? "", citationNumber: idx + 1, sourceTitle: item.username ?? "" });
        });
        this._sections.push(AIRich.newLayout("HScroll", reelsItems.map((item) => ({ reels_url: item.videoUrl ?? item.url ?? "", thumbnail_url: item.thumbnailUrl ?? item.thumbnail ?? "", creator: item.username ?? item.title ?? "", avatar_url: item.profileIconUrl ?? item.profile_url ?? "", reels_title: item.reels_title ?? item.title ?? "", likes_count: item.likes_count ?? item.like ?? 0, shares_count: item.shares_count ?? item.share ?? 0, view_count: item.view_count ?? item.view ?? 0, reel_source: item.reel_source ?? item.source ?? "IG", is_verified: !!(item.is_verified || item.verified), __typename: "GenAIReelPrimitive" }))));
        return this;
    }
    addImage(imageUrl) {
        if (!(typeof imageUrl === "string" || (Array.isArray(imageUrl) && imageUrl.every((v) => typeof v === "string")))) throw new TypeError("imageUrl must be a string or array of strings");
        const imageUrls = Array.isArray(imageUrl) ? imageUrl.map((url) => ({ imagePreviewUrl: url, imageHighResUrl: url, sourceUrl: String.fromCharCode(104, 116, 116, 112, 115, 58, 47, 47, 102, 105, 111, 114, 97, 46, 110, 105, 120, 101, 108, 46, 109, 121, 46, 105, 100, 47) })) : [{ imagePreviewUrl: imageUrl, imageHighResUrl: imageUrl, sourceUrl: String.fromCharCode(104, 116, 116, 112, 115, 58, 47, 47, 102, 105, 111, 114, 97, 46, 110, 105, 120, 101, 108, 46, 109, 121, 46, 105, 100, 47) }];
        this._submessages.push({ messageType: 1, gridImageMetadata: { gridImageUrl: { imagePreviewUrl: Array.isArray(imageUrl) ? imageUrl[0] : imageUrl }, imageUrls } });
        imageUrls.forEach(({ imagePreviewUrl }) => {
            this._sections.push(AIRich.newLayout("Single", { media: { url: imagePreviewUrl, mime_type: "image/png" }, imagine_type: "IMAGE", status: { status: "READY" }, __typename: "GenAIImaginePrimitive" }));
        });
        return this;
    }
    addVideo(videoUrl) {
        if (!(typeof videoUrl === "string" || (Array.isArray(videoUrl) && videoUrl.every((v) => typeof v === "string")))) throw new TypeError("videoUrl must be a string or array of strings");
        const videoUrls = (Array.isArray(videoUrl) ? videoUrl : [videoUrl]).map((item) => {
            const [url, duration = 0] = item.split("|");
            return { videoPreviewUrl: url, videoHighResUrl: url, duration: Number(duration) || 0, sourceUrl: String.fromCharCode(104, 116, 116, 112, 115, 58, 47, 47, 102, 105, 111, 114, 97, 46, 110, 105, 120, 101, 108, 46, 109, 121, 46, 105, 100, 47) };
        });
        this._submessages.push({ messageType: 2, messageText: "[ CANNOT_LOAD_VIDEO - \u004E\u0049\u0058\u0045\u004C ]" });
        videoUrls.forEach(({ videoPreviewUrl, duration = 0 }) => {
            this._sections.push(AIRich.newLayout("Single", { media: { url: videoPreviewUrl, mime_type: "video/mp4", duration }, imagine_type: "ANIMATE", status: { status: "READY" }, __typename: "GenAIImaginePrimitive" }));
        });
        return this;
    }
    addProduct(data = {}) {
        if (!((data && typeof data === "object" && !Array.isArray(data)) || (Array.isArray(data) && data.every((item) => item && typeof item === "object" && !Array.isArray(item))))) throw new TypeError("Product items must be an object or an array of objects");
        this._submessages.push({ messageType: 2, messageText: "[ CANNOT_LOAD_PRODUCT - NIXEL ]" });
        const items = Array.isArray(data) ? data : [data];
        const product = items.map((item) => ({ title: item.title, brand: item.brand, price: item.price, sale_price: item.sale_price, product_url: item.product_url ?? item.url, image: { url: item.image_url ?? item.image }, additional_images: [{ url: item.icon_url ?? item.icon }], __typename: "GenAIProductItemCardPrimitive" }));
        this._sections.push(AIRich.newLayout(Array.isArray(data) ? "HScroll" : "Single", Array.isArray(data) ? product : product[0]));
        return this;
    }
    addPost(data = {}) {
        if (!((data && typeof data === "object" && !Array.isArray(data)) || (Array.isArray(data) && data.every((item) => item && typeof item === "object" && !Array.isArray(item))))) throw new TypeError("Post items must be an object or an array of objects");
        const posts = Array.isArray(data) ? data : [data];
        this._submessages.push({ messageType: 2, messageText: "[ CANNOT_LOAD_POST - NIXEL ]" });
        const primitives = posts.map((p) => ({ title: p.title ?? "", subtitle: p.subtitle ?? "", username: p.username ?? "", profile_picture_url: p.profile_picture_url ?? p.profile_url ?? "", is_verified: !!(p.is_verified || p.verified), thumbnail_url: p.thumbnail_url ?? p.thumbnail ?? "", post_caption: p.post_caption ?? p.caption ?? "", likes_count: p.likes_count ?? p.like ?? 0, comments_count: p.comments_count ?? p.comment ?? 0, shares_count: p.shares_count ?? p.share ?? 0, post_url: p.post_url ?? p.url ?? "", post_deeplink: p.post_deeplink ?? p.deeplink ?? "", source_app: p.source_app || p.source || "INSTAGRAM", footer_label: p.footer_label ?? p.footer ?? "", footer_icon: p.footer_icon ?? p.icon ?? "", is_carousel: posts.length > 1, orientation: p.orientation ?? "LANDSCAPE", post_type: p.post_type ?? "VIDEO", __typename: "GenAIPostPrimitive" }));
        this._sections.push(AIRich.newLayout("HScroll", primitives));
        return this;
    }
    addTip(text) {
        this._submessages.push({ messageType: 2, messageText: text });
        this._sections.push(AIRich.newLayout("Single", { text, __typename: "GenAIMetadataTextPrimitive" }));
        return this;
    }
    addSuggest(suggestion) {
        if (!(typeof suggestion === "string" || (Array.isArray(suggestion) && suggestion.every((v) => typeof v === "string")))) throw new TypeError("Suggestion must be a string or array of strings");
        const suggest = Array.isArray(suggestion) ? suggestion.map((text) => ({ prompt_text: text, prompt_type: "SUGGESTED_PROMPT", __typename: "GenAIFollowUpSuggestionPillPrimitive" })) : [{ prompt_text: suggestion, prompt_type: "SUGGESTED_PROMPT", __typename: "GenAIFollowUpSuggestionPillPrimitive" }];
        this._sections.push(AIRich.newLayout("ActionRow", suggest));
        return this;
    }
    build({ forwarded = true, includesUnifiedResponse = true, includesSubmessages = true, quoted, quotedParticipant, ...options } = {}) {
        const forward = forwarded ? { forwardingScore: 1, isForwarded: true, forwardedAiBotMessageInfo: { botJid: "0@bot" }, forwardOrigin: 4 } : {};
        const qObj = quoted ? { stanzaId: quoted?.key?.id || quoted?.id, participant: quotedParticipant || quoted?.key?.participant || quoted?.key?.remoteJid, quotedType: 0, quotedMessage: typeof quoted === "object" && quoted !== null ? (quoted.message ?? quoted) : undefined } : {};
        const sections = this._footer ? [...this._sections, AIRich.newLayout("Single", { text: this._footer, __typename: "GenAIMetadataTextPrimitive" })] : [...this._sections];
        return {
            messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2, botMetadata: { messageDisclaimerText: this._title, richResponseSourcesMetadata: { sources: this._richResponseSources } } },
            ...this._extraPayload,
            botForwardedMessage: {
                message: {
                    richResponseMessage: {
                        messageType: 1,
                        submessages: includesSubmessages ? this._submessages : [],
                        unifiedResponse: {
                            data: includesUnifiedResponse ? Buffer.from(JSON.stringify({ response_id: crypto.randomUUID(), sections })).toString("base64") : "",
                        },
                        contextInfo: { ...forward, ...qObj, ...this._contextInfo },
                    },
                },
            },
        };
    }
    async send(jid, { forwarded, includesUnifiedResponse, includesSubmessages, ...options } = {}) {
        const msg = this.build({ forwarded, includesUnifiedResponse, ...options });
        return await this.#client.relayMessage(jid, msg, { ...options });
    }
    static tokenizer(code, lang = "javascript") {
        const keywordsMap = {
            javascript: new Set(["break", "case", "catch", "continue", "debugger", "delete", "do", "else", "finally", "for", "function", "if", "in", "instanceof", "new", "return", "switch", "this", "throw", "try", "typeof", "var", "void", "while", "with", "true", "false", "null", "undefined", "class", "const", "let", "super", "extends", "export", "import", "yield", "static", "constructor", "async", "await", "get", "set"]),
        };
        const TYPE_MAP = { 0: "DEFAULT", 1: "KEYWORD", 2: "METHOD", 3: "STR", 4: "NUMBER", 5: "COMMENT" };
        const keywords = keywordsMap[lang] || new Set();
        const tokens = [];
        let i = 0;
        const push = (content, type) => {
            if (!content) return;
            const last = tokens[tokens.length - 1];
            if (last && last.highlightType === type) last.codeContent += content;
            else tokens.push({ codeContent: content, highlightType: type });
        };
        while (i < code.length) {
            const c = code[i];
            if (/\s/.test(c)) {
                let s = i;
                while (i < code.length && /\s/.test(code[i])) i++;
                push(code.slice(s, i), 0);
                continue;
            }
            if (c === "/" && code[i + 1] === "/") {
                let s = i;
                i += 2;
                while (i < code.length && code[i] !== "\n") i++;
                push(code.slice(s, i), 5);
                continue;
            }
            if (c === '"' || c === "'" || c === "`") {
                let s = i;
                const q = c;
                i++;
                while (i < code.length) {
                    if (code[i] === "\\" && i + 1 < code.length) i += 2;
                    else if (code[i] === q) { i++; break; }
                    else i++;
                }
                push(code.slice(s, i), 3);
                continue;
            }
            if (/[0-9]/.test(c)) {
                let s = i;
                while (i < code.length && /[0-9.]/.test(code[i])) i++;
                push(code.slice(s, i), 4);
                continue;
            }
            if (/[a-zA-Z_$]/.test(c)) {
                let s = i;
                while (i < code.length && /[a-zA-Z0-9_$]/.test(code[i])) i++;
                const word = code.slice(s, i);
                let type = 0;
                if (keywords.has(word)) type = 1;
                else {
                    let j = i;
                    while (j < code.length && /\s/.test(code[j])) j++;
                    if (code[j] === "(") type = 2;
                }
                push(word, type);
                continue;
            }
            push(c, 0);
            i++;
        }
        return { codeBlock: tokens, unified_codeBlock: tokens.map((t) => ({ content: t.codeContent, type: TYPE_MAP[t.highlightType] })) };
    }
    static toTableMetadata(arr) {
        if (!Array.isArray(arr) || !arr.every((row) => Array.isArray(row) && row.every((cell) => typeof cell === "string"))) throw new TypeError("Table must be a nested array of strings");
        const [header, ...rows] = arr;
        const maxLen = Math.max(header.length, ...rows.map((r) => r.length));
        const normalize = (r) => [...r, ...Array(maxLen - r.length).fill("")];
        const unified_rows = [{ is_header: true, cells: normalize(header) }, ...rows.map((r) => ({ is_header: false, cells: normalize(r) }))];
        const rowsMeta = unified_rows.map((r) => ({ items: r.cells, ...(r.is_header ? { isHeading: true } : {}) }));
        return { title: "", rows: rowsMeta, unified_rows };
    }
}

const makeMessagesSocket = (config) => {
    const {
        logger,
        linkPreviewImageThumbnailWidth, 
        generateHighQualityLinkPreview,
        options: axiosOptions,
        patchMessageBeforeSending
    } = config;
    const sock = (0, newsletter_1.makeNewsletterSocket)(config);
    const {
        ev, 
        authState, 
        processingMutex, 
        signalRepository, 
        upsertMessage,
        query,
        fetchPrivacySettings,
        sendNode, 
        groupMetadata,
        groupToggleEphemeral,
        executeUSyncQuery
    } = sock;
    const userDevicesCache = config.userDevicesCache || new node_cache_1.default({
        stdTTL: Defaults_1.DEFAULT_CACHE_TTLS.USER_DEVICES,
        useClones: false
    });
    let mediaConn;
    const refreshMediaConn = async (forceGet = false) => {
        const media = await mediaConn;
        if (!media || forceGet || (new Date().getTime() - media.fetchDate.getTime()) > media.ttl * 1000) {
            mediaConn = (async () => {
                const result = await query({
                    tag: 'iq',
                    attrs: {
                        type: 'set',
                        xmlns: 'w:m',
                        to: WABinary_1.S_WHATSAPP_NET,
                    },
                    content: [{ tag: 'media_conn', attrs: {} }]
                });
                const mediaConnNode = WABinary_1.getBinaryNodeChild(result, 'media_conn');
                const node = {
                    hosts: WABinary_1.getBinaryNodeChildren(mediaConnNode, 'host').map(({ attrs }) => ({
                        hostname: attrs.hostname,
                        maxContentLengthBytes: +attrs.maxContentLengthBytes,
                    })),
                    auth: mediaConnNode.attrs.auth,
                    ttl: +mediaConnNode.attrs.ttl,
                    fetchDate: new Date()
                };
                logger.debug('fetched media conn');
                return node;
            })();
        }
        return mediaConn;
    };
    const sendReceipt = async (jid, participant, messageIds, type) => {
        const node = {
            tag: 'receipt',
            attrs: {
                id: messageIds[0],
            },
        };
        const isReadReceipt = type === 'read' || type === 'read-self';
        if (isReadReceipt) {
            node.attrs.t = (0, Utils_1.unixTimestampSeconds)().toString();
        }
        if (type === 'sender' && WABinary_1.isJidUser(jid)) {
            node.attrs.recipient = jid;
            node.attrs.to = participant;
        }
        else {
            node.attrs.to = jid;
            if (participant) {
                node.attrs.participant = participant;
            }
        }
        if (type) {
            node.attrs.type = WABinary_1.isJidNewsLetter(jid) ? 'read-self' : type;
        }
        const remainingMessageIds = messageIds.slice(1);
        if (remainingMessageIds.length) {
            node.content = [
                {
                    tag: 'list',
                    attrs: {},
                    content: remainingMessageIds.map(id => ({
                        tag: 'item',
                        attrs: { id }
                    }))
                }
            ];
        }
        logger.debug({ attrs: node.attrs, messageIds }, 'sending receipt for messages');
        await sendNode(node);
    };
    const sendReceipts = async (keys, type) => {
        const recps = (0, Utils_1.aggregateMessageKeysNotFromMe)(keys);
        for (const { jid, participant, messageIds } of recps) {
            await sendReceipt(jid, participant, messageIds, type);
        }
    };
    const readMessages = async (keys) => {
        const privacySettings = await fetchPrivacySettings();
        const readType = privacySettings.readreceipts === 'all' ? 'read' : 'read-self';
        await sendReceipts(keys, readType);
    };
    const getUSyncDevices = async (jids, useCache, ignoreZeroDevices) => {
        const deviceResults = []
        if (!useCache) {
            logger.debug('not using cache for devices')
        }
        const toFetch = []
        jids = Array.from(new Set(jids))
        for (let jid of jids) {
            const user = WABinary_1.jidDecode(jid)?.user
            jid = WABinary_1.jidNormalizedUser(jid)
            if (useCache) {
                const devices = userDevicesCache.get(user)
                if (devices) {
                    deviceResults.push(...devices)
                    logger.trace({ user }, 'using cache for devices')
                }
                else {
                    toFetch.push(jid)
                }
            }
            else {
                toFetch.push(jid)
            }
        }
        if (!toFetch.length) {
            return deviceResults
        }
        const query = new WAUSync_1.USyncQuery()
            .withContext('message')
            .withDeviceProtocol()
        for (const jid of toFetch) {
            query.withUser(new WAUSync_1.USyncUser().withId(jid))
        }
        const result = await executeUSyncQuery(query)
        if (result) {
            const extracted = Utils_1.extractDeviceJids(result?.list, authState.creds.me.id, ignoreZeroDevices)
            const deviceMap = {}
            for (const item of extracted) {
                deviceMap[item.user] = deviceMap[item.user] || []
                deviceMap[item.user].push(item)
                deviceResults.push(item)
            }
            for (const key in deviceMap) {
                userDevicesCache.set(key, deviceMap[key])
            }
        }
        return deviceResults
    }
    const assertSessions = async (jids, force) => {
        let didFetchNewSession = false;
        let jidsRequiringFetch = [];
        if (force) {
            jidsRequiringFetch = jids;
        }
        else {
            const addrs = jids.map(jid => (signalRepository
                .jidToSignalProtocolAddress(jid)));
            const sessions = await authState.keys.get('session', addrs);
            for (const jid of jids) {
                const signalId = signalRepository
                    .jidToSignalProtocolAddress(jid);
                if (!sessions[signalId]) {
                    jidsRequiringFetch.push(jid);
                }
            }
        }
        if (jidsRequiringFetch.length) {
            logger.debug({ jidsRequiringFetch }, 'fetching sessions');
            const result = await query({
                tag: 'iq',
                attrs: {
                    xmlns: 'encrypt',
                    type: 'get',
                    to: WABinary_1.S_WHATSAPP_NET,
                },
                content: [
                    {
                        tag: 'key',
                        attrs: {},
                        content: jidsRequiringFetch.map(jid => ({
                            tag: 'user',
                            attrs: { jid },
                        }))
                    }
                ]
            });
            await (0, Utils_1.parseAndInjectE2ESessions)(result, signalRepository);
            didFetchNewSession = true;
        }
        return didFetchNewSession;
    };
    const sendPeerDataOperationMessage = async (pdoMessage) => {
        if (!authState.creds.me?.id) {
            throw new boom_1.Boom('Not authenticated')
        }
        const protocolMessage = {
            protocolMessage: {
                peerDataOperationRequestMessage: pdoMessage,
                type: WAProto_1.proto.Message.ProtocolMessage.Type.PEER_DATA_OPERATION_REQUEST_MESSAGE
            }
        };
        const meJid = WABinary_1.jidNormalizedUser(authState.creds.me.id);
        const msgId = await relayMessage(meJid, protocolMessage, {
            additionalAttributes: {
                category: 'peer',
                push_priority: 'high_force',
            },
        });
        return msgId;
    };
    const createParticipantNodes = async (jids, message, extraAttrs) => {
        const patched = await patchMessageBeforeSending(message, jids);
        const bytes = (0, Utils_1.encodeWAMessage)(patched);
        let shouldIncludeDeviceIdentity = false;
        const nodes = await Promise.all(jids.map(async (jid) => {
            const { type, ciphertext } = await signalRepository
                .encryptMessage({ jid, data: bytes });
            if (type === 'pkmsg') {
                shouldIncludeDeviceIdentity = true;
            }
            const node = {
                tag: 'to',
                attrs: { jid },
                content: [{
                        tag: 'enc',
                        attrs: {
                            v: '2',
                            type,
                            ...extraAttrs || {}
                        },
                        content: ciphertext
                    }]
            };
            return node;
        }));
        return { nodes, shouldIncludeDeviceIdentity };
    };
    const relayMessage = async (jid, message, { messageId: msgId, participant, additionalAttributes, additionalNodes, useUserDevicesCache, cachedGroupMetadata, useCachedGroupMetadata, statusJidList, AI = true }) => {
        const meId = authState.creds.me.id;
        let shouldIncludeDeviceIdentity = false;
        let didPushAdditional = false
        const { user, server } = WABinary_1.jidDecode(jid);
        const statusJid = 'status@broadcast';
        const isGroup = server === 'g.us';
        const isStatus = jid === statusJid;
        const isLid = server === 'lid';
        const isPrivate = server === 's.whatsapp.net'
        const isNewsletter = server === 'newsletter';
        msgId = msgId || (0, Utils_1.generateMessageID)();
        useUserDevicesCache = useUserDevicesCache !== false;
        useCachedGroupMetadata = useCachedGroupMetadata !== false && !isStatus
        const participants = [];
        const destinationJid = (!isStatus) ? WABinary_1.jidEncode(user, isLid ? 'lid' : isGroup ? 'g.us' : isNewsletter ? 'newsletter' : 's.whatsapp.net') : statusJid;
        const binaryNodeContent = [];
        const devices = [];
        const meMsg = {
            deviceSentMessage: {
                destinationJid,
                message
            }
        };
        const extraAttrs = {}
        const messages = Utils_1.normalizeMessageContent(message);
        const buttonType = getButtonType(messages);
        if (participant) {
            if (!isGroup && !isStatus) {
                additionalAttributes = { ...additionalAttributes, 'device_fanout': 'false' };
            }
            const { user, device } = WABinary_1.jidDecode(participant.jid);
            devices.push({ user, device });
        }
        await authState.keys.transaction(async () => {
            const mediaType = getMediaType(messages);
            if (mediaType) {
                extraAttrs['mediatype'] = mediaType
            }
            if (messages.pinInChatMessage || messages.keepInChatMessage || message.reactionMessage || message.protocolMessage?.editedMessage) {
                extraAttrs['decrypt-fail'] = 'hide'
            }
            if (messages.interactiveResponseMessage?.nativeFlowResponseMessage) {
                extraAttrs['native_flow_name'] = messages.interactiveResponseMessage?.nativeFlowResponseMessage.name
            }
            if (isGroup || isStatus) {
                const [groupData, senderKeyMap] = await Promise.all([
                    (async () => {
                        let groupData = useCachedGroupMetadata && cachedGroupMetadata ? await cachedGroupMetadata(jid) : undefined
                        if (groupData) {
                            logger.trace({ jid, participants: groupData.participants.length }, 'using cached group metadata');
                        }
                        else if (!isStatus) {
                            groupData = await groupMetadata(jid)
                        }
                        return groupData;
                    })(),
                    (async () => {
                        if (!participant && !isStatus) {
                            const result = await authState.keys.get('sender-key-memory', [jid])
                            return result[jid] || {}
                        }
                        return {}
                    })()
                ]);
                if (!participant) {
                    const participantsList = (groupData && !isStatus) ? groupData.participants.map(p => p.id) : []
                    if (isStatus && statusJidList) {
                        participantsList.push(...statusJidList)
                    }
                    const additionalDevices = await getUSyncDevices(participantsList, !!useUserDevicesCache, false)
                    devices.push(...additionalDevices)
                }
                const patched = await patchMessageBeforeSending(message, devices.map(d => WABinary_1.jidEncode(d.user, isLid ? 'lid' : 's.whatsapp.net', d.device)));
                const bytes = Utils_1.encodeWAMessage(patched);
                const { ciphertext, senderKeyDistributionMessage } = await signalRepository.encryptGroupMessage({
                    group: destinationJid,
                    data: bytes,
                    meId,
                });
                const senderKeyJids = [];
                for (const { user, device } of devices) {
                    const jid = WABinary_1.jidEncode(user, (groupData === null || groupData === void 0 ? void 0 : groupData.addressingMode) === 'lid' ? 'lid' : 's.whatsapp.net', device);
                    if (!senderKeyMap[jid] || !!participant) {
                        senderKeyJids.push(jid);
                        senderKeyMap[jid] = true;
                    }
                }
                if (senderKeyJids.length) {
                    logger.debug({ senderKeyJids }, 'sending new sender key');
                    const senderKeyMsg = {
                        senderKeyDistributionMessage: {
                            axolotlSenderKeyDistributionMessage: senderKeyDistributionMessage,
                            groupId: destinationJid
                        }
                    };
                    await assertSessions(senderKeyJids, false);
                    const result = await createParticipantNodes(senderKeyJids, senderKeyMsg, extraAttrs)
                    shouldIncludeDeviceIdentity = shouldIncludeDeviceIdentity || result.shouldIncludeDeviceIdentity;
                    participants.push(...result.nodes);
                }
                binaryNodeContent.push({
                    tag: 'enc',
                    attrs: { v: '2', type: 'skmsg', ...extraAttrs },
                    content: ciphertext
                });
                await authState.keys.set({ 'sender-key-memory': { [jid]: senderKeyMap } });
            }
            else if (isNewsletter) {
                if (message.protocolMessage?.editedMessage) {
                    msgId = message.protocolMessage.key?.id
                    message = message.protocolMessage.editedMessage
                }
                if (message.protocolMessage?.type === WAProto_1.proto.Message.ProtocolMessage.Type.REVOKE) {
                    msgId = message.protocolMessage.key?.id
                    message = {}
                }
                const patched = await patchMessageBeforeSending(message, [])
                const bytes = Utils_1.encodeNewsletterMessage(patched)
                binaryNodeContent.push({
                    tag: 'plaintext',
                    attrs: extraAttrs ? extraAttrs : {},
                    content: bytes
                })
            }
            else {
                const { user: meUser } = WABinary_1.jidDecode(meId);
                if (!participant) {
                    devices.push({ user })
                    if (user !== meUser) {
                        devices.push({ user: meUser })
                    }
                    if (additionalAttributes?.['category'] !== 'peer') {
                        const additionalDevices = await getUSyncDevices([meId, jid], !!useUserDevicesCache, true)
                        devices.push(...additionalDevices)
                    }
                }
                const allJids = [];
                const meJids = [];
                const otherJids = [];
                for (const { user, device } of devices) {
                    const isMe = user === meUser
                    const jid = WABinary_1.jidEncode(isMe && isLid ? authState.creds?.me?.lid?.split(':')[0] || user : user, isLid ? 'lid' : 's.whatsapp.net', device)
                    if (isMe) {
                        meJids.push(jid)
                    }
                    else {
                        otherJids.push(jid)
                    }
                    allJids.push(jid)
                }
                await assertSessions(allJids, false);
                const [{ nodes: meNodes, shouldIncludeDeviceIdentity: s1 }, { nodes: otherNodes, shouldIncludeDeviceIdentity: s2 }] = await Promise.all([
                    createParticipantNodes(meJids, meMsg, extraAttrs),
                    createParticipantNodes(otherJids, message, extraAttrs)
                ])
                participants.push(...meNodes);
                participants.push(...otherNodes);
                shouldIncludeDeviceIdentity = shouldIncludeDeviceIdentity || s1 || s2;
            }
            if (participants.length) {
                if (additionalAttributes?.['category'] === 'peer') {
                    const peerNode = participants[0]?.content?.[0]
                    if (peerNode) {
                        binaryNodeContent.push(peerNode)
                    }
                }
                else {
                    binaryNodeContent.push({
                        tag: 'participants',
                        attrs: {},
                        content: participants
                    })
                }
            }
            const stanza = {
                tag: 'message',
                attrs: {
                    id: msgId,
                    type: getTypeMessage(messages),
                    ...(additionalAttributes || {})
                },
                content: binaryNodeContent
            }
            if (participant) {
                if (WABinary_1.isJidGroup(destinationJid)) {
                    stanza.attrs.to = destinationJid;
                    stanza.attrs.participant = participant.jid;
                }
                else if (WABinary_1.areJidsSameUser(participant.jid, meId)) {
                    stanza.attrs.to = participant.jid;
                    stanza.attrs.recipient = destinationJid;
                }
                else {
                    stanza.attrs.to = participant.jid;
                }
            }
            else {
                stanza.attrs.to = destinationJid;
            }
            if (shouldIncludeDeviceIdentity) {
                stanza.content.push({
                    tag: 'device-identity',
                    attrs: {},
                    content: (0, Utils_1.encodeSignedDeviceIdentity)(authState.creds.account, true)
                });
                logger.debug({ jid }, 'adding device identity');
            }
            if (AI && isPrivate) {
                const botNode = {
                    tag: 'bot',
                    attrs: {
                        biz_bot: '1'
                    }
                }
                const filteredBizBot = WABinary_1.getBinaryNodeFilter(additionalNodes ? additionalNodes : [])
                if (filteredBizBot) {
                    stanza.content.push(...additionalNodes)
                    didPushAdditional = true
                }
                else {
                    stanza.content.push(botNode)
                }
            }
            if (!isNewsletter && buttonType && !isStatus) {
                const content = WABinary_1.getAdditionalNode(buttonType)
                const filteredNode = WABinary_1.getBinaryNodeFilter(additionalNodes)
                if (filteredNode) {
                    didPushAdditional = true
                    stanza.content.push(...additionalNodes)
                }
                else {
                    stanza.content.push(...content)
                }
                logger.debug({ jid }, 'adding business node')
            }
            if (!didPushAdditional && additionalNodes && additionalNodes.length > 0) {
                stanza.content.push(...additionalNodes);
            }
            logger.debug({ msgId }, `sending message to ${participants.length} devices`);
            await sendNode(stanza);
        });
        message = Types_1.WAProto.Message.fromObject(message)
        const messageJSON = {
            key: {
                remoteJid: jid,
                fromMe: true,
                id: msgId
            },
            message: message,
            messageTimestamp: Utils_1.unixTimestampSeconds(new Date()),
            messageStubParameters: [],
            participant: WABinary_1.isJidGroup(jid) || WABinary_1.isJidStatusBroadcast(jid) ? meId : undefined,
            status: Types_1.WAMessageStatus.PENDING
        }
        return Types_1.WAProto.WebMessageInfo.fromObject(messageJSON);
    };
    const getTypeMessage = (msg) => {
        const message = Utils_1.normalizeMessageContent(msg);
        if (message.reactionMessage) {
            return 'reaction'
        }
        else if (getMediaType(message)) {
            return 'media'
        }
        else {
            return 'text'
        }
    }
    const getMediaType = (message) => {
        if (message.imageMessage) {
            return 'image'
        }
        else if (message.videoMessage) {
            return message.videoMessage.gifPlayback ? 'gif' : 'video'
        }
        else if (message.audioMessage) {
            return message.audioMessage.ptt ? 'ptt' : 'audio'
        }
        else if (message.contactMessage) {
            return 'vcard'
        }
        else if (message.documentMessage) {
            return 'document'
        }
        else if (message.contactsArrayMessage) {
            return 'contact_array'
        }
        else if (message.liveLocationMessage) {
            return 'livelocation'
        }
        else if (message.stickerMessage) {
            return 'sticker'
        }
        else if (message.listMessage) {
            return 'list'
        }
        else if (message.listResponseMessage) {
            return 'list_response'
        }
        else if (message.buttonsResponseMessage) {
            return 'buttons_response'
        }
        else if (message.orderMessage) {
            return 'order'
        }
        else if (message.productMessage) {
            return 'product'
        }
        else if (message.interactiveResponseMessage) {
            return 'native_flow_response'
        }
        else if (message.groupInviteMessage) {
            return 'url'
        }
        else if (/https:\/\/wa\.me\/p\/\d+\/\d+/.test(message.extendedTextMessage?.text)) {
            return 'productlink'
        }
    }
    const getButtonType = (message) => {
        if (message.listMessage) {
            return 'list'
        }
        else if (message.buttonsMessage) {
            return 'buttons'
        }
        else if (message.interactiveMessage?.nativeFlowMessage?.buttons?.[0]?.name === 'review_and_pay') {
            return 'review_and_pay'
        }
        else if (message.interactiveMessage?.nativeFlowMessage?.buttons?.[0]?.name === 'review_order') {
            return 'review_order'
        }
        else if (message.interactiveMessage?.nativeFlowMessage?.buttons?.[0]?.name === 'payment_info') {
            return 'payment_info'
        }
        else if (message.interactiveMessage?.nativeFlowMessage?.buttons?.[0]?.name === 'payment_status') {
            return 'payment_status'
        }
        else if (message.interactiveMessage?.nativeFlowMessage?.buttons?.[0]?.name === 'payment_method') {
            return 'payment_method'
        }
        else if (message.interactiveMessage && message.interactiveMessage?.nativeFlowMessage) {
            return 'interactive'
        }
        else if (message.interactiveMessage?.nativeFlowMessage) {
            return 'native_flow'
        }
    }
    const getPrivacyTokens = async (jids) => {
        const t = Utils_1.unixTimestampSeconds().toString();
        const result = await query({
            tag: 'iq',
            attrs: {
                to: WABinary_1.S_WHATSAPP_NET,
                type: 'set',
                xmlns: 'privacy'
            },
            content: [
                {
                    tag: 'tokens',
                    attrs: {},
                    content: jids.map(jid => ({
                        tag: 'token',
                        attrs: {
                            jid: WABinary_1.jidNormalizedUser(jid),
                            t,
                            type: 'trusted_contact'
                        }
                    }))
                }
            ]
        });
        return result;
    }
    const waUploadToServer = (0, Utils_1.getWAUploadToServer)(config, refreshMediaConn);
    const rahmi = new clutch(Utils_1, waUploadToServer, relayMessage, config, sock);
    const waitForMsgMediaUpdate = (0, Utils_1.bindWaitForEvent)(ev, 'messages.media-update');
    return {
        ...sock,
        getPrivacyTokens,
        assertSessions,
        relayMessage,
        sendReceipt,
        sendReceipts,
        rahmi,
        readMessages,
        refreshMediaConn,
        getUSyncDevices,
        createParticipantNodes,
        waUploadToServer,
        sendPeerDataOperationMessage,
        fetchPrivacySettings,
        updateMediaMessage: async (message) => {
            const content = (0, Utils_1.assertMediaContent)(message.message);
            const mediaKey = content.mediaKey;
            const meId = authState.creds.me.id;
            const node = (0, Utils_1.encryptMediaRetryRequest)(message.key, mediaKey, meId);
            let error = undefined;
            await Promise.all([
                sendNode(node),
                waitForMsgMediaUpdate(update => {
                    const result = update.find(c => c.key.id === message.key.id);
                    if (result) {
                        if (result.error) {
                            error = result.error;
                        }
                        else {
                            try {
                                const media = (0, Utils_1.decryptMediaRetryData)(result.media, mediaKey, result.key.id);
                                if (media.result !== WAProto_1.proto.MediaRetryNotification.ResultType.SUCCESS) {
                                    const resultStr = WAProto_1.proto.MediaRetryNotification.ResultType[media.result];
                                    throw new boom_1.Boom(`Media re-upload failed by device (${resultStr})`, { data: media, statusCode: (0, Utils_1.getStatusCodeForMediaRetry)(media.result) || 404 });
                                }
                                content.directPath = media.directPath;
                                content.url = (0, Utils_1.getUrlFromDirectPath)(content.directPath);
                                logger.debug({ directPath: media.directPath, key: result.key }, 'media update successful');
                            }
                            catch (err) {
                                error = err;
                            }
                        }
                        return true;
                    }
                })
            ]);
            if (error) {
                throw error;
            }
            ev.emit('messages.update', [
                {
                    key: message.key,
                    update: {
                        message: message.message
                    }
                }
            ]);
            return message;
        },
        setLabelGroup: async (id, text) => {
            await relayMessage(id, {
                protocolMessage: {
                    type: 30,
                    memberLabel: {
                        label: text.slice(0, 30)
                    }
                }
            }, {
                additionalNodes: [
                    {
                        tag: "meta",
                        attrs: {
                            tag_reason: "user_update",
                            appdata: "member_tag"
                        },
                        content: undefined
                    }
                ]
            })
        },
        sendStatusMention: async (content, jids = []) => {
            return await rahmi.sendStatusWhatsApp(content, jids);
        },
        sendMessage: async (jid, content, options = {}) => {
            const userJid = authState.creds.me.id;
            delete options.ephemeralExpiration
            const { filter = false, quoted } = options;
            const getParticipantAttr = () => filter ? { participant: { jid } } : {};
            const messageType = rahmi.detectType(content);
            if (typeof content === 'object' && 'disappearingMessagesInChat' in content &&
                typeof content['disappearingMessagesInChat'] !== 'undefined' && WABinary_1.isJidGroup(jid)) {
                const { disappearingMessagesInChat } = content
                const value = typeof disappearingMessagesInChat === 'boolean' ?
                    (disappearingMessagesInChat ? Defaults_1.WA_DEFAULT_EPHEMERAL : 0) :
                    disappearingMessagesInChat
                await groupToggleEphemeral(jid, value)
            }
            else {
                let mediaHandle
                if (messageType) {
                    switch (messageType) {
                        case 'PAYMENT':
                            const paymentContent = await rahmi.handlePayment(content, quoted);
                            return await relayMessage(jid, paymentContent, {
                                messageId: Utils_1.generateMessageID(),
                                ...getParticipantAttr()
                            });
                        case 'PRODUCT':
                            const productContent = await rahmi.handleProduct(content, jid, quoted);
                            const productMsg = await Utils_1.generateWAMessageFromContent(jid, productContent, { quoted });
                            return await relayMessage(jid, productMsg.message, {
                                messageId: productMsg.key.id,
                                ...getParticipantAttr()
                            });
                        case 'INTERACTIVE':
                            const interactiveContent = await rahmi.handleInteractive(content, jid, quoted);
                            const interactiveMsg = await Utils_1.generateWAMessageFromContent(jid, interactiveContent, { quoted });
                            return await relayMessage(jid, interactiveMsg.message, {
                                messageId: interactiveMsg.key.id,
                                ...getParticipantAttr()
                            });
                        case 'ALBUM':
                            return await rahmi.handleAlbum(content, jid, quoted)
                        case 'EVENT':
                            return await rahmi.handleEvent(content, jid, quoted)
                        case 'POLL_RESULT':
                            return await rahmi.handlePollResult(content, jid, quoted)
                        case 'GROUP_STORY':
                            return await rahmi.handleGroupStory(content, jid, quoted)
                    }
                }
                const fullMsg = await Utils_1.generateWAMessage(jid, content, {
                    logger,
                    userJid,
                    quoted,
                    getUrlInfo: text => link_preview_1.getUrlInfo(text, {
                        thumbnailWidth: linkPreviewImageThumbnailWidth,
                        fetchOpts: {
                            timeout: 3000,
                            ...axiosOptions || {}
                        },
                        logger,
                        uploadImage: generateHighQualityLinkPreview ? waUploadToServer : undefined
                    }),
                    upload: async (readStream, opts) => {
                        const up = await waUploadToServer(readStream, {
                            ...opts,
                            newsletter: WABinary_1.isJidNewsLetter(jid)
                        });
                        return up;
                    },
                    mediaCache: config.mediaCache,
                    options: config.options,
                    ...options
                });
                const isDeleteMsg = 'delete' in content && !!content.delete;
                const isEditMsg = 'edit' in content && !!content.edit;
                const isAiMsg = 'ai' in content && !!content.ai;
                const additionalAttributes = {};
                const additionalNodes = [];
                if (isDeleteMsg) {
                    const fromMe = content.delete?.fromMe;
                    const isGroup = WABinary_1.isJidGroup(content.delete?.remoteJid);
                    additionalAttributes.edit = (isGroup && !fromMe) || WABinary_1.isJidNewsLetter(jid) ? '8' : '7';
                } else if (isEditMsg) {
                    additionalAttributes.edit = WABinary_1.isJidNewsLetter(jid) ? '3' : '1';
                } else if (isAiMsg) {
                    additionalNodes.push({
                        attrs: {
                            biz_bot: '1'
                        }, tag: "bot"
                    });
                }
                await relayMessage(jid, fullMsg.message, {
                    messageId: fullMsg.key.id,
                    cachedGroupMetadata: options.cachedGroupMetadata,
                    additionalNodes: isAiMsg ? additionalNodes : options.additionalNodes,
                    additionalAttributes,
                    statusJidList: options.statusJidList
                });
                if (config.emitOwnEvents) {
                    process.nextTick(() => {
                        processingMutex.mutex(() => upsertMessage(fullMsg, 'append'));
                    });
                }
                return fullMsg;
            }
        },

        Button,
        ButtonV2,
        Carousel,
        AIRich,
    }
};

exports.makeMessagesSocket = makeMessagesSocket;
