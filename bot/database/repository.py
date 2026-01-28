"""Database repository for CRUD operations."""

from datetime import datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import selectinload

from bot.config import settings
from bot.database.models import Base, Conversation, Message, User


class Repository:
    """Repository for database operations."""

    def __init__(self) -> None:
        self.engine = create_async_engine(settings.database_url, echo=False)
        self.session_factory = async_sessionmaker(self.engine, expire_on_commit=False)

    async def init_db(self) -> None:
        """Initialize the database, creating tables if needed."""
        async with self.engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)

    async def get_or_create_user(
        self,
        session: AsyncSession,
        telegram_id: int,
        username: str | None = None,
        first_name: str | None = None,
    ) -> User:
        """Get existing user or create a new one."""
        stmt = select(User).where(User.telegram_id == telegram_id)
        result = await session.execute(stmt)
        user = result.scalar_one_or_none()

        if user is None:
            user = User(
                telegram_id=telegram_id,
                username=username,
                first_name=first_name,
            )
            session.add(user)
            await session.flush()
        else:
            if username is not None:
                user.username = username
            if first_name is not None:
                user.first_name = first_name

        return user

    async def get_or_create_conversation(
        self,
        session: AsyncSession,
        user_id: int,
        chat_id: int,
        thread_id: int | None = None,
    ) -> Conversation:
        """Get existing conversation or create a new one."""
        stmt = select(Conversation).where(
            Conversation.chat_id == chat_id,
            Conversation.thread_id == thread_id,
        )
        result = await session.execute(stmt)
        conversation = result.scalar_one_or_none()

        if conversation is None:
            conversation = Conversation(
                user_id=user_id,
                chat_id=chat_id,
                thread_id=thread_id,
            )
            session.add(conversation)
            await session.flush()
        else:
            conversation.updated_at = datetime.utcnow()

        return conversation

    async def add_message(
        self,
        session: AsyncSession,
        conversation_id: int,
        role: str,
        content: str,
        message_id: int | None = None,
        image_file_id: str | None = None,
        pdf_file_id: str | None = None,
    ) -> Message:
        """Add a message to a conversation."""
        message = Message(
            conversation_id=conversation_id,
            role=role,
            content=content,
            message_id=message_id,
            image_file_id=image_file_id,
            pdf_file_id=pdf_file_id,
        )
        session.add(message)
        await session.flush()
        return message

    async def get_conversation_messages(
        self,
        session: AsyncSession,
        conversation_id: int,
    ) -> list[Message]:
        """Get all messages for a conversation."""
        stmt = (
            select(Message)
            .where(Message.conversation_id == conversation_id)
            .order_by(Message.created_at)
        )
        result = await session.execute(stmt)
        return list(result.scalars().all())

    async def get_user_by_telegram_id(
        self,
        session: AsyncSession,
        telegram_id: int,
    ) -> User | None:
        """Get user by Telegram ID."""
        stmt = select(User).where(User.telegram_id == telegram_id)
        result = await session.execute(stmt)
        return result.scalar_one_or_none()

    async def toggle_show_thinking(
        self,
        session: AsyncSession,
        telegram_id: int,
    ) -> bool:
        """Toggle show_thinking for a user and return new value."""
        user = await self.get_user_by_telegram_id(session, telegram_id)
        if user:
            user.show_thinking = not user.show_thinking
            return user.show_thinking
        return False

    async def get_conversation_with_messages(
        self,
        session: AsyncSession,
        chat_id: int,
        thread_id: int | None = None,
    ) -> Conversation | None:
        """Get conversation with all messages loaded."""
        stmt = (
            select(Conversation)
            .options(selectinload(Conversation.messages))
            .where(
                Conversation.chat_id == chat_id,
                Conversation.thread_id == thread_id,
            )
        )
        result = await session.execute(stmt)
        return result.scalar_one_or_none()


repository = Repository()
