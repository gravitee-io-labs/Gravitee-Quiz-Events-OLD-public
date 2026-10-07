# ruff: noqa
# VERBATIM copy of backend/app/database.py at git commit 63d4171955b2c6b2a0e5349f7da9e656334cf874 (the legacy, pre-multi-event application).
# Frozen test fixture: DO NOT EDIT, DO NOT IMPORT. tests/legacy/builder.py runs it in a subprocess to
# reproduce the exact production schema. See tests/legacy/README.md.
"""
Database configuration and session management
"""
import logging
from sqlalchemy import create_engine, event
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import QueuePool

from app.config import settings

logger = logging.getLogger(__name__)

# Create database engine with connection pooling
engine = create_engine(
    settings.DATABASE_URL,
    poolclass=QueuePool,
    pool_size=10,
    max_overflow=20,
    pool_pre_ping=True,  # Enable connection health checks
    pool_recycle=3600,  # Recycle connections after 1 hour
    echo=False  # Set to True for SQL query logging
)

# Session factory
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

# Base class for models
Base = declarative_base()


def get_db():
    """
    Database session dependency for FastAPI endpoints
    Yields a database session and ensures it's closed after use
    """
    db = SessionLocal()
    try:
        yield db
    except Exception as e:
        logger.error(f"Database session error: {str(e)}")
        db.rollback()
        raise
    finally:
        db.close()


def init_db():
    """
    Initialize database - create all tables and seed initial data
    """
    from app.models import User, Question, GameSession, GameAnswer, GameSettings
    
    logger.info("Creating database tables...")
    Base.metadata.create_all(bind=engine)
    logger.info("Database tables created")
    
    # Seed initial data
    db = SessionLocal()
    try:
        # Create default game settings if not exists
        existing_settings = db.query(GameSettings).first()
        if not existing_settings:
            logger.info("Creating default game settings...")
            default_settings = GameSettings(
                questions_per_game=settings.DEFAULT_QUESTIONS_PER_GAME,
                timer_seconds=settings.DEFAULT_TIMER_SECONDS,
                points_correct=settings.DEFAULT_POINTS_CORRECT,
                points_wrong=settings.DEFAULT_POINTS_WRONG,
                time_bonus_max=settings.DEFAULT_TIME_BONUS_MAX
            )
            db.add(default_settings)
            db.commit()
            logger.info("Default game settings created")
        
        # Create default questions if none exist
        existing_questions = db.query(Question).count()
        if existing_questions == 0:
            logger.info("Creating default questions...")
            default_questions = [
                Question(
                    question_text_en="What does API stand for?",
                    question_text_fr="Que signifie API ?",
                    correct_answer="green",
                    green_label_en="Application Programming Interface",
                    green_label_fr="Interface de Programmation d'Application",
                    red_label_en="Advanced Programming Integration",
                    red_label_fr="Intégration de Programmation Avancée",
                    explanation_en="API stands for Application Programming Interface, which allows different software applications to communicate with each other.",
                    explanation_fr="API signifie Interface de Programmation d'Application, qui permet à différentes applications logicielles de communiquer entre elles.",
                    question_type="text",
                    is_active=True
                ),
                Question(
                    question_text_en="What is the default HTTP method for reading data in REST APIs?",
                    question_text_fr="Quelle est la méthode HTTP par défaut pour lire des données dans les API REST ?",
                    correct_answer="green",
                    green_label_en="GET",
                    green_label_fr="GET",
                    red_label_en="POST",
                    red_label_fr="POST",
                    explanation_en="GET is the HTTP method used to retrieve data from a server without modifying it.",
                    explanation_fr="GET est la méthode HTTP utilisée pour récupérer des données d'un serveur sans les modifier.",
                    question_type="text",
                    is_active=True
                ),
                Question(
                    question_text_en="What HTTP status code indicates a successful request?",
                    question_text_fr="Quel code de statut HTTP indique une requête réussie ?",
                    correct_answer="green",
                    green_label_en="200",
                    green_label_fr="200",
                    red_label_en="404",
                    red_label_fr="404",
                    explanation_en="HTTP status code 200 (OK) indicates that the request was successful.",
                    explanation_fr="Le code de statut HTTP 200 (OK) indique que la requête a réussi.",
                    question_type="text",
                    is_active=True
                ),
                Question(
                    question_text_en="What does REST stand for?",
                    question_text_fr="Que signifie REST ?",
                    correct_answer="green",
                    green_label_en="Representational State Transfer",
                    green_label_fr="Transfert d'État Représentationnel",
                    red_label_en="Remote Execution Service Technology",
                    red_label_fr="Technologie de Service d'Exécution à Distance",
                    explanation_en="REST stands for Representational State Transfer, an architectural style for designing networked applications.",
                    explanation_fr="REST signifie Transfert d'État Représentationnel, un style architectural pour concevoir des applications réseau.",
                    question_type="text",
                    is_active=True
                ),
                Question(
                    question_text_en="What is an API Gateway?",
                    question_text_fr="Qu'est-ce qu'une passerelle API ?",
                    correct_answer="green",
                    green_label_en="A server that acts as an entry point for APIs",
                    green_label_fr="Un serveur qui agit comme point d'entrée pour les API",
                    red_label_en="A database management system",
                    red_label_fr="Un système de gestion de base de données",
                    explanation_en="An API Gateway is a server that acts as an API front-end, receiving requests, routing them to appropriate services, and aggregating results.",
                    explanation_fr="Une passerelle API est un serveur qui agit comme front-end API, recevant les requêtes, les routant vers les services appropriés et agrégeant les résultats.",
                    question_type="text",
                    is_active=True
                ),
                Question(
                    question_text_en="What does JSON stand for?",
                    question_text_fr="Que signifie JSON ?",
                    correct_answer="green",
                    green_label_en="JavaScript Object Notation",
                    green_label_fr="JavaScript Object Notation",
                    red_label_en="Java Structured Object Network",
                    red_label_fr="Java Structured Object Network",
                    explanation_en="JSON (JavaScript Object Notation) is a lightweight data-interchange format that is easy for humans to read and write.",
                    explanation_fr="JSON (JavaScript Object Notation) est un format d'échange de données léger, facile à lire et à écrire pour les humains.",
                    question_type="text",
                    is_active=True
                ),
                Question(
                    question_text_en="What HTTP method is used to create a new resource?",
                    question_text_fr="Quelle méthode HTTP est utilisée pour créer une nouvelle ressource ?",
                    correct_answer="green",
                    green_label_en="POST",
                    green_label_fr="POST",
                    red_label_en="GET",
                    red_label_fr="GET",
                    explanation_en="POST is the HTTP method used to create new resources on the server.",
                    explanation_fr="POST est la méthode HTTP utilisée pour créer de nouvelles ressources sur le serveur.",
                    question_type="text",
                    is_active=True
                ),
                Question(
                    question_text_en="What does CORS stand for?",
                    question_text_fr="Que signifie CORS ?",
                    correct_answer="green",
                    green_label_en="Cross-Origin Resource Sharing",
                    green_label_fr="Partage de Ressources entre Origines Croisées",
                    red_label_en="Central Online Resource System",
                    red_label_fr="Système Central de Ressources en Ligne",
                    explanation_en="CORS (Cross-Origin Resource Sharing) is a security feature that allows or restricts resources on a web page to be requested from another domain.",
                    explanation_fr="CORS (Partage de Ressources entre Origines Croisées) est une fonctionnalité de sécurité qui autorise ou restreint les ressources d'une page web à être demandées depuis un autre domaine.",
                    question_type="text",
                    is_active=True
                ),
                Question(
                    question_text_en="What is OAuth used for?",
                    question_text_fr="À quoi sert OAuth ?",
                    correct_answer="green",
                    green_label_en="Authorization and authentication",
                    green_label_fr="Autorisation et authentification",
                    red_label_en="Database encryption",
                    red_label_fr="Chiffrement de base de données",
                    explanation_en="OAuth is an open standard for access delegation, commonly used for authorization and authentication.",
                    explanation_fr="OAuth est un standard ouvert pour la délégation d'accès, couramment utilisé pour l'autorisation et l'authentification.",
                    question_type="text",
                    is_active=True
                ),
                Question(
                    question_text_en="What HTTP status code indicates 'Not Found'?",
                    question_text_fr="Quel code de statut HTTP indique 'Non Trouvé' ?",
                    correct_answer="green",
                    green_label_en="404",
                    green_label_fr="404",
                    red_label_en="200",
                    red_label_fr="200",
                    explanation_en="HTTP status code 404 indicates that the requested resource could not be found on the server.",
                    explanation_fr="Le code de statut HTTP 404 indique que la ressource demandée n'a pas pu être trouvée sur le serveur.",
                    question_type="text",
                    is_active=True
                ),
                Question(
                    question_text_en="What is GraphQL?",
                    question_text_fr="Qu'est-ce que GraphQL ?",
                    correct_answer="green",
                    green_label_en="A query language for APIs",
                    green_label_fr="Un langage de requête pour les API",
                    red_label_en="A database management system",
                    red_label_fr="Un système de gestion de base de données",
                    explanation_en="GraphQL is a query language for APIs that provides a flexible and efficient alternative to REST.",
                    explanation_fr="GraphQL est un langage de requête pour les API qui offre une alternative flexible et efficace à REST.",
                    question_type="text",
                    is_active=True
                ),
                Question(
                    question_text_en="What does HTTP stand for?",
                    question_text_fr="Que signifie HTTP ?",
                    correct_answer="green",
                    green_label_en="HyperText Transfer Protocol",
                    green_label_fr="Protocole de Transfert HyperTexte",
                    red_label_en="High Transfer Technology Protocol",
                    red_label_fr="Protocole de Technologie de Transfert Haute",
                    explanation_en="HTTP (HyperText Transfer Protocol) is the foundation of data communication on the web.",
                    explanation_fr="HTTP (Protocole de Transfert HyperTexte) est la fondation de la communication de données sur le web.",
                    question_type="text",
                    is_active=True
                ),
                Question(
                    question_text_en="What is a webhook?",
                    question_text_fr="Qu'est-ce qu'un webhook ?",
                    correct_answer="green",
                    green_label_en="An automated message sent from apps when something happens",
                    green_label_fr="Un message automatique envoyé par les applications quand quelque chose se produit",
                    red_label_en="A type of database",
                    red_label_fr="Un type de base de données",
                    explanation_en="A webhook is a method for an app to provide real-time information to other applications by sending automated messages when events occur.",
                    explanation_fr="Un webhook est une méthode permettant à une application de fournir des informations en temps réel à d'autres applications en envoyant des messages automatiques lorsque des événements se produisent.",
                    question_type="text",
                    is_active=True
                ),
                Question(
                    question_text_en="What does SSL stand for?",
                    question_text_fr="Que signifie SSL ?",
                    correct_answer="green",
                    green_label_en="Secure Sockets Layer",
                    green_label_fr="Couche de Sockets Sécurisée",
                    red_label_en="System Security Link",
                    red_label_fr="Lien de Sécurité Système",
                    explanation_en="SSL (Secure Sockets Layer) is a protocol for establishing encrypted links between a web server and a browser.",
                    explanation_fr="SSL (Couche de Sockets Sécurisée) est un protocole pour établir des liens cryptés entre un serveur web et un navigateur.",
                    question_type="text",
                    is_active=True
                ),
                Question(
                    question_text_en="What is rate limiting in APIs?",
                    question_text_fr="Qu'est-ce que la limitation de taux dans les API ?",
                    correct_answer="green",
                    green_label_en="Restricting the number of requests a client can make",
                    green_label_fr="Restreindre le nombre de requêtes qu'un client peut faire",
                    red_label_en="Increasing server speed",
                    red_label_fr="Augmenter la vitesse du serveur",
                    explanation_en="Rate limiting is a technique to control the number of requests a client can make to an API within a specified time period.",
                    explanation_fr="La limitation de taux est une technique pour contrôler le nombre de requêtes qu'un client peut faire à une API dans une période de temps spécifiée.",
                    question_type="text",
                    is_active=True
                ),
                Question(
                    question_text_en="What does PUT method do in REST API?",
                    question_text_fr="Que fait la méthode PUT dans l'API REST ?",
                    correct_answer="green",
                    green_label_en="Updates an existing resource",
                    green_label_fr="Met à jour une ressource existante",
                    red_label_en="Deletes a resource",
                    red_label_fr="Supprime une ressource",
                    explanation_en="PUT is the HTTP method used to update existing resources or create them if they don't exist.",
                    explanation_fr="PUT est la méthode HTTP utilisée pour mettre à jour des ressources existantes ou les créer si elles n'existent pas.",
                    question_type="text",
                    is_active=True
                ),
                Question(
                    question_text_en="What is API versioning?",
                    question_text_fr="Qu'est-ce que le versioning d'API ?",
                    correct_answer="green",
                    green_label_en="Managing different versions of an API",
                    green_label_fr="Gérer différentes versions d'une API",
                    red_label_en="Encrypting API data",
                    red_label_fr="Chiffrer les données API",
                    explanation_en="API versioning is the practice of managing changes to an API by creating different versions to maintain backward compatibility.",
                    explanation_fr="Le versioning d'API est la pratique de gérer les changements d'une API en créant différentes versions pour maintenir la compatibilité descendante.",
                    question_type="text",
                    is_active=True
                ),
                Question(
                    question_text_en="What is JWT?",
                    question_text_fr="Qu'est-ce que JWT ?",
                    correct_answer="green",
                    green_label_en="JSON Web Token",
                    green_label_fr="JSON Web Token",
                    red_label_en="Java Web Technology",
                    red_label_fr="Java Web Technology",
                    explanation_en="JWT (JSON Web Token) is a compact, URL-safe means of representing claims to be transferred between two parties for authentication.",
                    explanation_fr="JWT (JSON Web Token) est un moyen compact et sûr pour les URL de représenter des revendications à transférer entre deux parties pour l'authentification.",
                    question_type="text",
                    is_active=True
                ),
                Question(
                    question_text_en="What HTTP method is used to delete a resource?",
                    question_text_fr="Quelle méthode HTTP est utilisée pour supprimer une ressource ?",
                    correct_answer="green",
                    green_label_en="DELETE",
                    green_label_fr="DELETE",
                    red_label_en="REMOVE",
                    red_label_fr="REMOVE",
                    explanation_en="DELETE is the HTTP method used to remove resources from the server.",
                    explanation_fr="DELETE est la méthode HTTP utilisée pour supprimer des ressources du serveur.",
                    question_type="text",
                    is_active=True
                ),
                Question(
                    question_text_en="What is microservices architecture?",
                    question_text_fr="Qu'est-ce que l'architecture microservices ?",
                    correct_answer="green",
                    green_label_en="An approach where apps are built as small independent services",
                    green_label_fr="Une approche où les applications sont construites comme de petits services indépendants",
                    red_label_en="A type of database",
                    red_label_fr="Un type de base de données",
                    explanation_en="Microservices architecture is an approach where applications are built as a collection of small, independent services that communicate via APIs.",
                    explanation_fr="L'architecture microservices est une approche où les applications sont construites comme une collection de petits services indépendants qui communiquent via des API.",
                    question_type="text",
                    is_active=True
                ),
            ]
            db.add_all(default_questions)
            db.commit()
            logger.info(f"Created {len(default_questions)} default questions")
        
    except Exception as e:
        logger.error(f"Error initializing database: {str(e)}")
        db.rollback()
    finally:
        db.close()


# Log database connection events
@event.listens_for(engine, "connect")
def receive_connect(dbapi_conn, connection_record):
    logger.debug("Database connection established")


@event.listens_for(engine, "close")
def receive_close(dbapi_conn, connection_record):
    logger.debug("Database connection closed")
