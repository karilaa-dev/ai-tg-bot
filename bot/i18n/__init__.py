"""Internationalization module."""

from bot.i18n.translations import TRANSLATIONS, Language, detect_language, get_text

__all__ = ["Language", "TRANSLATIONS", "detect_language", "get_text"]
